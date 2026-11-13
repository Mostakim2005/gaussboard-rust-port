// Dual-viewport Split Study Workspace.
// Hosts two independent document/camera/surface viewports side-by-side in the DOM.

import { h } from './popover.js';
import { Surface } from '../core/surface.js';
import { Store, boundsOf } from '../core/store.js';
import { EXCERPT_MIME } from '../core/excerpts.js';
import { pageRects } from '../core/pages.js';
import { Interaction } from '../core/tools.js';
import { PropertiesDialog } from './properties-dialog.js';
import { TextEditor } from './textedit.js';
import { icon } from './icons.js';
import { uid } from '../core/util.js';
import { t } from '../i18n.js';
import { TabBar } from './tabs.js';

export class SplitWorkspace {
  /**
   * @param {object} app The main application instance
   * @param {HTMLElement} [host] Container element (defaults to #stage)
   */
  constructor(app, host = null) {
    this.app = app;
    this.host = host || (typeof document !== 'undefined' ? document.getElementById('stage') : null);
    this.enabled = false;
    this.ratio = 0.5; // 0.2 to 0.8
    this.wrapper = null;
    this.leftPane = null;
    this.rightPane = null;
    this.orientation = 'vertical'; // 'vertical' | 'horizontal'
    this.excerptDockEl = null;
    this.divider = null;
    this.leftStore = null;
    this.leftSurface = null;
    this.leftInteraction = null;
    this.leftNib = null;
    this.leftBoardId = null;
    this.leftPropertiesDialog = null;
    this._saveTimer = null;
    this._resizeHandler = null;
    this._pickerOutsideClick = null;
    this.primaryCanvas = null;
    this.originalCanvasParent = null;
    this.originalCanvasNextSibling = null;
    this.reparentedNodes = [];
    this.boardList = [];
    this.pickerDropdown = null;
    this.pickerInput = null;
    this.splitTopbarLeft = null;
    this.splitTopbarRightBadge = null;
    this.splitLeftTitleInput = null;
    this.splitLeftChips = null;
  }

  get active() {
    return this.enabled;
  }

  get isOpen() {
    return this.enabled;
  }

  /** Remember which pane the user last pressed in ("left" or "main"). */
  setActivePane(pane) {
    if (pane !== 'left' && pane !== 'main') return;
    this.activePane = pane;
    // Only one pane can own the keyboard. Clearing the other pane's selection
    // means a keyboard command that is still primary-board bound (Delete,
    // Copy, z-order) cannot act on objects in the pane the user is not in.
    if (pane === 'left') {
      if (this.app?.surface?.selection?.size) {
        this.app.surface.selection.clear();
        this.app.syncUI?.();
        this.app.surface.invalidate?.();
      }
    } else if (this.leftSurface?.selection?.size) {
      this.leftSurface.selection.clear();
      this.leftSurface.invalidate?.();
    }
  }

  /**
   * Does the reference pane own keyboard edits right now? The last pressed
   * pane wins, so a stray pointer resting over the other pane cannot redirect
   * Ctrl+Z to a board the user is not working on.
   */
  isLeftFocused() {
    if (!this.enabled) return false;
    if (this.activePane) return this.activePane === 'left';
    return !!this.isPointerOverLeft;
  }

  /**
   * Mount dual-viewport workspace layout.
   */
  async enable({ leftBoardData = null, ratio = 0.5, leftBoardId = null } = {}) {
    if (this.enabled) return;
    if (typeof document === 'undefined') {
      this.enabled = true;
      return;
    }

    this.host = this.host || document.getElementById('stage');
    if (!this.host) return;

    this.primaryCanvas = document.getElementById('c');
    if (!this.primaryCanvas) return;

    const currentMainId = this.app?.store?.doc?.id || this.app?.boardId;
    await this.refreshBoardList();

    const otherBoards = (this.boardList || []).filter(b => b.id && b.id !== currentMainId);

    // Split view requires at least two boards. Never split a board with itself.
    if (!leftBoardData && !leftBoardId) {
      if (otherBoards.length === 0) {
        this.app?.toast?.(t('Split view requires at least two boards to view side by side. Create another board or open one from My boards.'));
        return;
      }
      leftBoardId = otherBoards[0].id;
    } else if (leftBoardId && leftBoardId === currentMainId) {
      this.app?.toast?.(t('A board cannot be split against itself. Please select a different board.'));
      if (otherBoards.length > 0) {
        leftBoardId = otherBoards[0].id;
        leftBoardData = null;
      } else {
        return;
      }
    }

    if (!leftBoardData && leftBoardId) {
      try {
        const cachedEntry = this.boardList?.find((b) => b.id === leftBoardId)?.cachedDoc
          || this._cachedTabPayload(leftBoardId);
        let loaded = cachedEntry ? structuredClone(cachedEntry) : null;
        if (!loaded) {
          if (typeof window.board?.boards?.load === 'function') {
            loaded = await window.board.boards.load(leftBoardId);
          } else if (typeof window.board?.boards?.get === 'function') {
            loaded = await window.board.boards.get(leftBoardId);
          } else if (this.app?.storage?.load) {
            loaded = await this.app.storage.load(leftBoardId);
          }
        }
        if (typeof loaded === 'string') {
          try { loaded = JSON.parse(loaded); } catch {}
        }
        if (!loaded && cachedEntry === undefined) {
          loaded = { id: leftBoardId, name: this.boardList?.find((b) => b.id === leftBoardId)?.name || t('Untitled board'), objects: [] };
        }
        if (loaded) {
          if (!loaded.name && loaded.title) loaded.name = loaded.title;
          if (!Array.isArray(loaded.objects) && Array.isArray(loaded.elements)) loaded.objects = loaded.elements;
          leftBoardData = (await this.app?.resolveAssets?.(loaded)) || loaded;
        }
      } catch (err) {
        console.warn('Could not auto-load left board for split view:', err);
      }
    }

    this.ratio = Math.max(0.2, Math.min(0.8, ratio));
    this.leftBoardId = leftBoardId || null;

    // Stash original elements to reparent and restore on disable.
    // #editLayer and #ctxbar stay in #stage: they are shared overlays whose
    // positions are measured from the stage, and a pane has overflow:hidden.
    const toReparent = [
      this.primaryCanvas,
      document.getElementById('inkNib')
    ].filter(Boolean);

    const moving = new Set(toReparent);
    this.reparentedNodes = toReparent.map(node => {
      // Anchor on the nearest following sibling that is NOT moved, so the
      // original order can be rebuilt on disable.
      let anchor = node.nextSibling;
      while (anchor && moving.has(anchor)) anchor = anchor.nextSibling;
      return { node, parent: node.parentNode, anchor };
    });
    this.originalCanvasParent = this.primaryCanvas.parentNode;
    this.originalCanvasNextSibling = this.primaryCanvas.nextSibling;

    // Create wrapper layout
    this.wrapper = h('div', {
      id: 'splitWorkspace',
      class: 'split-workspace',
      style: 'position:absolute;inset:0;display:flex;width:100%;height:100%;overflow:hidden;z-index:2;'
    });

    // Left pane (Reference deck / Study board)
    this.leftPane = h('div', {
      id: 'stageLeft',
      class: 'split-pane split-left',
      style: `position:relative;flex:none;width:${(this.ratio * 100).toFixed(1)}%;height:100%;overflow:hidden;background:var(--desk,#f0f0f0);display:flex;flex-direction:column;`
    });

    // Board picker combobox
    const boardPickerEl = this.buildBoardPicker();

    // Left pane buttons: Undo, Redo, Properties, Swap, Close
    const btnUndo = h('button', {
      class: 'btn-split-undo',
      title: t('Undo (Left board)'),
      style: 'background:none;border:none;cursor:pointer;padding:4px;color:inherit;display:flex;align-items:center;opacity:0.8;',
      html: icon('undo', 16)
    });
    btnUndo.addEventListener('click', () => {
      if (!this.leftStore) return;
      this.leftStore.undo();
      this.leftSurface?.repaintAll();
      this.saveLeftBoardDebounced();
    });

    const btnRedo = h('button', {
      class: 'btn-split-redo',
      title: t('Redo (Left board)'),
      style: 'background:none;border:none;cursor:pointer;padding:4px;color:inherit;display:flex;align-items:center;opacity:0.8;',
      html: icon('redo', 16)
    });
    btnRedo.addEventListener('click', () => {
      if (!this.leftStore) return;
      this.leftStore.redo();
      this.leftSurface?.repaintAll();
      this.saveLeftBoardDebounced();
    });

    const btnProps = h('button', {
      class: 'btn-split-props',
      title: t('Board Properties — Study Board'),
      style: 'background:rgba(0,0,0,0.05);border:1px solid var(--line,rgba(0,0,0,0.1));border-radius:6px;cursor:pointer;padding:3px 7px;font-size:11px;font-weight:600;color:inherit;display:flex;align-items:center;gap:4px;',
      html: '<span style="font-weight:700;color:#0078d4;">#</span><span>' + t('Properties') + '</span>'
    });
    btnProps.addEventListener('click', () => {
      if (!this.leftStore?.doc) return;
      if (!this.leftPropertiesDialog) {
        this.leftPropertiesDialog = new PropertiesDialog(this.app, {
          doc: this.leftStore.doc,
          onSave: async () => {
            await this.saveLeftBoard();
          }
        });
      } else {
        this.leftPropertiesDialog.targetDoc = this.leftStore.doc;
      }
      this.leftPropertiesDialog.open();
    });

    const btnSwap = h('button', {
      class: 'btn-split-swap',
      title: t('Swap left and right boards'),
      style: 'background:rgba(0,120,212,0.12);border:1px solid var(--line,rgba(0,120,212,0.3));border-radius:6px;cursor:pointer;padding:3px 8px;font-size:11px;font-weight:600;color:var(--accent,#0078d4);display:flex;align-items:center;gap:4px;',
      html: '<span style="font-size:13px;line-height:1;">⇄</span><span>' + t('Swap') + '</span>'
    });
    btnSwap.addEventListener('click', () => this.swapPanes());

    const syncActive = !!this.app?.settings?.splitSyncScroll;
    const btnSyncScroll = h('button', {
      class: 'btn-split-sync-scroll' + (syncActive ? ' active' : ''),
      title: t('Sync pan & zoom across panes'),
      'aria-pressed': String(syncActive),
      style: `background:${syncActive ? 'rgba(0,120,212,0.14)' : 'none'};border:none;border-radius:6px;cursor:pointer;padding:4px;color:${syncActive ? 'var(--accent,#0078d4)' : 'inherit'};display:flex;align-items:center;`,
      html: icon('link', 15)
    });
    this.btnSyncScroll = btnSyncScroll;
    btnSyncScroll.addEventListener('click', () => {
      if (!this.app?.settings) return;
      const next = !this.app.settings.splitSyncScroll;
      this.app.settings.splitSyncScroll = next;
      this.app.saveSettings?.();
      this.syncScrollUI();
      this.app.toast?.(next ? t('Split view scroll synchronized') : t('Split view scroll independent'));
    });

    const btnOrient = h('button', {
      class: 'btn-split-orient',
      title: t('Toggle vertical / horizontal layout'),
      style: 'background:none;border:none;cursor:pointer;padding:4px;color:inherit;display:flex;align-items:center;font-size:13px;',
      html: '⬌'
    });
    btnOrient.addEventListener('click', () => {
      this.toggleOrientation();
      btnOrient.innerHTML = this.orientation === 'horizontal' ? '⬍' : '⬌';
    });

    const btnExcerpt = h('button', {
      class: 'btn-split-excerpt-dock',
      title: t('Toggle excerpt shelf dock'),
      style: 'background:none;border:none;cursor:pointer;padding:3px 6px;color:inherit;display:flex;align-items:center;font-size:11px;gap:3px;border-radius:4px;border:1px solid rgba(0,0,0,0.1);',
      html: '<span>📦</span><span>' + t('Excerpts') + '</span>'
    });
    btnExcerpt.addEventListener('click', () => this.toggleExcerptDock());

    const btnCloseSplit = h('button', {
      class: 'btn-split-close',
      title: t('Close split view'),
      style: 'background:none;border:none;cursor:pointer;padding:4px;color:inherit;display:flex;align-items:center;',
      html: icon('close', 16)
    });
    btnCloseSplit.addEventListener('click', () => this.disable());

    const actionsWrap = h('div', {
      style: 'display:flex;align-items:center;gap:3px;'
    }, btnUndo, btnRedo, btnProps, btnSyncScroll, btnOrient, btnExcerpt, btnSwap, btnCloseSplit);

    const leftHeader = h('div', {
      class: 'split-left-header',
      style: 'height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 8px;background:var(--surface,#ffffff);border-bottom:1px solid var(--line,rgba(0,0,0,0.1));z-index:10;gap:8px;'
    }, boardPickerEl, actionsWrap);

    // Left canvas viewport wrapper
    const canvasWrap = h('div', {
      class: 'split-left-canvas-wrap',
      style: 'position:relative;flex:1;width:100%;height:100%;overflow:hidden;'
    });

    // Left secondary canvas
    const cLeft = document.createElement('canvas');
    cLeft.id = 'cLeft';
    cLeft.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
    canvasWrap.appendChild(cLeft);

    // Left ink nib cursor
    const leftNib = h('div', {
      id: 'inkNibLeft',
      style: 'position:absolute;pointer-events:none;z-index:99;display:none;width:24px;height:24px;background-size:contain;background-repeat:no-repeat;transform:translate3d(-50%,-50%,0);'
    });
    canvasWrap.appendChild(leftNib);
    this.leftNib = leftNib;

    this.leftPane.appendChild(leftHeader);
    this.leftPane.appendChild(canvasWrap);

    // Track active pointer position over left split pane for smart undo/redo routing
    this.isPointerOverLeft = false;
    this.leftPane.addEventListener('pointerenter', () => { this.isPointerOverLeft = true; });
    this.leftPane.addEventListener('pointerleave', () => { this.isPointerOverLeft = false; });
    this.leftPane.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes(EXCERPT_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.leftPane.addEventListener('drop', (e) => {
      const raw = e.dataTransfer?.getData(EXCERPT_MIME);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.app?.readingMode || !this.leftStore || !this.leftSurface) return;
      try {
        const payload = JSON.parse(raw);
        this.app.insertExcerptPayload(payload, this.leftSurface.toWorld(e), {
          store: this.leftStore,
          surface: this.leftSurface,
          onChange: () => this.saveLeftBoardDebounced()
        });
      } catch { this.app?.toast?.(t('This excerpt could not be added')); }
    });

    // Divider
    this.divider = h('div', {
      class: 'split-divider',
      style: 'width:6px;background:var(--line,rgba(0,0,0,0.15));cursor:col-resize;user-select:none;touch-action:none;position:relative;z-index:10;'
    });

    // Right pane (Primary canvas)
    this.rightPane = h('div', {
      id: 'stageRight',
      class: 'split-pane split-right',
      style: 'position:relative;flex:1;height:100%;overflow:hidden;'
    });

    // Reparent primary canvas into right pane
    for (const rec of this.reparentedNodes) {
      this.rightPane.appendChild(rec.node);
    }

    this.wrapper.appendChild(this.leftPane);
    this.wrapper.appendChild(this.divider);
    this.wrapper.appendChild(this.rightPane);
    this.host.appendChild(this.wrapper);

    // Initialize left subsystem
    this.leftStore = new Store();
    if (leftBoardData) {
      this.leftStore.load(leftBoardData);
      const boardName = leftBoardData.name || leftBoardData.title;
      if (this.pickerInput && boardName) {
        this.pickerInput.value = boardName;
      }
      // resolveAssets() takes a board payload (`objects` array) and returns a
      // NEW document; the store's live doc is a dictionary. Only the resolved
      // picture sources are copied back in place - reloading the store here
      // would throw away anything drawn or pasted before the promise settles.
      Promise.resolve(this.app?.resolveAssets?.(this.leftStore.toJSON())).then((resolved) => {
        if (!resolved || !Array.isArray(resolved.objects) || !this.leftStore || !this.enabled) return;
        let touched = false;
        for (const o of resolved.objects) {
          const live = o && this.leftStore.doc.objects[o.id];
          if (!live || live.src === o.src) continue;
          live.src = o.src;
          if (o.assetId) live.assetId = o.assetId;
          if (o.missing) live.missing = true;
          touched = true;
        }
        if (touched) {
          this.leftStore.rev++;
          this.leftSurface?.invalidate();
        }
      }).catch(() => {});
    }
    this.leftSurface = new Surface(cLeft, this.leftStore, { lowLatency: false });
    this.leftSurface.resize();
    this._leftStoreUnsub = this.leftStore.subscribe(() => {
      this.leftSurface?.invalidate();
      // A reference board that was never picked from disk has no file of its
      // own. Give it one as soon as something is drawn, or closing the split
      // would drop the work with no copy anywhere.
      if (!this.leftBoardId && this.leftStore?.count) {
        this.leftBoardId = this.leftStore.doc.id || null;
        if (this.pickerInput && !this.pickerInput.value) {
          this.pickerInput.value = this.leftStore.doc.name || t('Untitled');
        }
      }
      this.saveLeftBoardDebounced();
    });

    // Wire divider drag interaction
    this.wireDivider(this.divider);

    // Proxy for dual interaction pipeline
    const leftAppProxy = new Proxy(this.app, {
      get: (target, prop) => {
        if (prop === 'store') return this.leftStore;
        if (prop === 'surface') return this.leftSurface;
        if (prop === 'inkNibEl') return this.leftNib;
        if (prop === 'textEditor') return this.leftTextEditor || target.textEditor;
        if (prop === 'syncUI') return () => this.leftSurface?.invalidate();
        if (prop === 'syncZoom') return () => {
          this.syncCameraFromLeft();
          this.leftSurface?.invalidate();
        };
        if (prop === 'onGestureEnd') return () => this.saveLeftBoardDebounced();
        if (prop === 'setSelection') return (ids, additive = false) => {
          const sel = this.leftSurface?.selection;
          if (!sel) return;
          if (!additive) sel.clear();
          for (const id of ids) {
            if (this.leftStore?.has(id)) sel.add(id);
          }
          this.leftSurface?.invalidate();
        };
        return target[prop];
      }
    });

    // Typing on the reference board goes through its own editor bound to the
    // left store and camera; the primary editor would save the words onto the
    // other board (or nowhere).
    this.leftTextEditor = new TextEditor(leftAppProxy);

    // The pane the user last pressed in owns keyboard edits (Ctrl+Z / Ctrl+Y).
    this.activePane = null;
    this.leftPane.addEventListener('pointerdown', () => this.setActivePane('left'), true);
    this.rightPane.addEventListener('pointerdown', () => this.setActivePane('main'), true);

    this.leftInteraction = new Interaction(leftAppProxy, {
      surface: this.leftSurface,
      store: this.leftStore,
      canvas: cLeft,
      inkNib: this.leftNib
    });

    // Wire left canvas navigation (fallback if Interaction is not bound and sync hooks)
    this.wireLeftCanvasNavigation(cLeft);

    this._resizeHandler = () => {
      if (this.leftSurface) this.leftSurface.resize();
      if (this.app?.surface) this.app.surface.resize();
    };
    window.addEventListener('resize', this._resizeHandler);

    // Update primary canvas surface size
    if (this.app?.surface) {
      this.app.surface.resize();
    }

    // Mount the split topbar partition above the left and right boards
    this.mountSplitTopbar();

    this.enabled = true;
  }

  /**
   * Dismantle dual-viewport and restore single canvas layout.
   */
  disable() {
    if (!this.enabled) return;

    this.unmountSplitTopbar();

    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    // Typed words on the reference board are committed to its store before the
    // store goes away; saveLeftBoard() then snapshots the board synchronously,
    // so the write still happens once this teardown has finished.
    if (this.leftTextEditor) {
      try { this.leftTextEditor.commit(); } catch { /* nothing being typed */ }
      this.leftTextEditor = null;
    }
    if (this.leftBoardId) {
      this.saveLeftBoard();
    }

    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    if (this._pickerOutsideClick) {
      window.removeEventListener('pointerdown', this._pickerOutsideClick);
      this._pickerOutsideClick = null;
    }

    if (this._leftStoreUnsub) {
      try { this._leftStoreUnsub(); } catch {}
      this._leftStoreUnsub = null;
    }

    if (this.leftInteraction) {
      this.leftInteraction.destroy();
      this.leftInteraction = null;
    }

    if (this.leftSurface) {
      this.leftSurface.destroy?.();
      this.leftSurface.stop?.();
      this.leftSurface = null;
    }
    this.leftStore = null;
    this.leftNib = null;
    this.leftBoardId = null;
    this.isPointerOverLeft = false;
    this.activePane = null;
    this.excerptDockEl = null;

    if (this.leftPropertiesDialog) {
      this.leftPropertiesDialog.close();
      this.leftPropertiesDialog = null;
    }

    if (this.reparentedNodes?.length) {
      // Put each node back where it came from, in order, using the nearest
      // following sibling that stayed behind as the anchor. Appending blindly
      // changed the stacking order the app expects.
      let prevRestored = null;
      for (const rec of this.reparentedNodes) {
        const parent = rec.parent;
        if (!rec.node || !parent || typeof parent.insertBefore !== 'function') continue;
        if (prevRestored && prevRestored.parentNode === parent) {
          parent.insertBefore(rec.node, prevRestored.nextSibling);
        } else if (rec.anchor && parent.contains(rec.anchor)) {
          parent.insertBefore(rec.node, rec.anchor);
        } else {
          parent.appendChild(rec.node);
        }
        prevRestored = rec.node;
      }
      this.reparentedNodes = [];
    } else if (this.primaryCanvas && this.originalCanvasParent) {
      if (this.originalCanvasNextSibling && typeof this.originalCanvasParent.insertBefore === 'function') {
        this.originalCanvasParent.insertBefore(this.primaryCanvas, this.originalCanvasNextSibling);
      } else if (typeof this.originalCanvasParent.appendChild === 'function') {
        this.originalCanvasParent.appendChild(this.primaryCanvas);
      }
    }

    if (this.wrapper) {
      if (typeof this.wrapper.remove === 'function') {
        this.wrapper.remove();
      } else if (this.wrapper.parentNode && typeof this.wrapper.parentNode.removeChild === 'function') {
        this.wrapper.parentNode.removeChild(this.wrapper);
      }
      this.wrapper = null;
    }

    this.leftPane = null;
    this.rightPane = null;
    this.divider = null;
    this.pickerDropdown = null;
    this.pickerInput = null;

    if (this.app?.surface) {
      this.app.surface.resize();
    }

    this.enabled = false;
  }

  async toggle(opts = {}) {
    if (this.enabled) this.disable();
    else await this.enable(opts);
  }

  setRatio(r) {
    this.ratio = Math.max(0.2, Math.min(0.8, r));
    if (this.orientation === 'horizontal') {
      if (this.leftPane) {
        this.leftPane.style.width = '100%';
        this.leftPane.style.height = `${(this.ratio * 100).toFixed(1)}%`;
      }
      if (this.rightPane) {
        this.rightPane.style.width = '100%';
        this.rightPane.style.height = `${((1 - this.ratio) * 100).toFixed(1)}%`;
      }
    } else {
      if (this.leftPane) {
        this.leftPane.style.width = `${(this.ratio * 100).toFixed(1)}%`;
        this.leftPane.style.height = '100%';
      }
      if (this.rightPane) {
        this.rightPane.style.width = `${((1 - this.ratio) * 100).toFixed(1)}%`;
        this.rightPane.style.height = '100%';
      }
    }
    if (this.splitTopbarLeft) {
      this.splitTopbarLeft.style.width = `${(this.ratio * 100).toFixed(1)}%`;
    }
    if (this.leftSurface) this.leftSurface.resize();
    if (this.app?.surface) this.app.surface.resize();
  }

  setOrientation(mode = 'vertical') {
    this.orientation = mode === 'horizontal' ? 'horizontal' : 'vertical';
    if (!this.wrapper) return;
    if (this.orientation === 'horizontal') {
      this.wrapper.style.flexDirection = 'column';
      if (this.divider) {
        this.divider.style.width = '100%';
        this.divider.style.height = '6px';
        this.divider.style.cursor = 'row-resize';
      }
    } else {
      this.wrapper.style.flexDirection = 'row';
      if (this.divider) {
        this.divider.style.width = '6px';
        this.divider.style.height = '100%';
        this.divider.style.cursor = 'col-resize';
      }
    }
    this.setRatio(this.ratio);
  }

  toggleOrientation() {
    this.setOrientation(this.orientation === 'vertical' ? 'horizontal' : 'vertical');
    this.app.toast?.(this.orientation === 'horizontal' ? t('Split layout: Horizontal (Top / Bottom)') : t('Split layout: Vertical (Left / Right)'));
  }

  toggleExcerptDock() {
    if (this.excerptDockEl) {
      this.excerptDockEl.remove();
      this.excerptDockEl = null;
      return;
    }
    const dock = h('div', {
      class: 'split-excerpt-dock',
      style: 'position:absolute;bottom:0;left:0;right:0;height:120px;background:rgba(20,24,30,0.95);backdrop-filter:blur(10px);border-top:1px solid rgba(255,255,255,0.15);z-index:90;display:flex;flex-direction:column;padding:8px 12px;box-shadow:0 -4px 16px rgba(0,0,0,0.3);'
    });

    const dockHeader = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;'
    },
      h('div', { style: 'font-size:12px;font-weight:700;color:#00e5ff;display:flex;align-items:center;gap:6px;' },
        '📦', h('span', {}, t('Excerpt Shelf Dock'))
      ),
      h('button', {
        class: 'btn btn-ghost',
        style: 'padding:1px 6px;font-size:12px;line-height:1;',
        title: t('Close shelf')
      }, '✕')
    );
    dockHeader.children[1].addEventListener('click', () => {
      dock.remove();
      this.excerptDockEl = null;
    });

    const dockScroll = h('div', {
      style: 'flex:1;display:flex;gap:10px;overflow-x:auto;align-items:center;'
    });

    const leftObjects = Object.values(this.leftStore?.doc?.objects || {});
    const rightObjects = Object.values(this.app?.store?.doc?.objects || {});
    const excerpts = [...leftObjects, ...rightObjects].filter(o => o && o.type === 'image' && o.excerptSource);

    if (!excerpts.length) {
      dockScroll.appendChild(h('div', {
        style: 'font-size:12px;color:rgba(255,255,255,0.45);padding:10px;'
      }, t('No excerpts found on boards yet. Select content and use Copy Excerpt to capture.')));
    } else {
      excerpts.forEach((ex, idx) => {
        const thumb = h('div', {
          style: 'flex-shrink:0;height:70px;width:90px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;padding:2px;',
          title: t('Click to drop excerpt onto active board · Double-click to open source')
        },
          ex.src ? h('img', { src: ex.src, style: 'max-width:100%;max-height:50px;object-fit:contain;' }) : h('span', {}, '🖼️'),
          h('span', { style: 'font-size:10px;color:rgba(255,255,255,0.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;text-align:center;' }, ex.excerptSource?.boardName || `Excerpt ${idx + 1}`)
        );

        thumb.addEventListener('click', () => {
          if (this.app?.surface?.cam) {
            const view = this.app.surface.cam.viewport(this.app.surface.width, this.app.surface.height);
            const center = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
            const newObj = JSON.parse(JSON.stringify(ex));
            // Unique id: Date.now() repeats when an excerpt is stamped twice in
            // the same millisecond and the second copy replaces the first.
            newObj.id = uid('img');
            newObj.x = center.x - (newObj.w || 200) / 2;
            newObj.y = center.y - (newObj.h || 150) / 2;
            this.app.store?.add(newObj, 'paste_excerpt');
            this.app.recordExcerptBacklink?.(newObj, this.app.store);
            this.app.surface?.damageAll();
            this.app.toast?.(t('Excerpt stamped onto canvas'));
          }
        });
        thumb.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          this.app?.openExcerptSource?.(ex);
        });
        dockScroll.appendChild(thumb);
      });
    }

    dock.appendChild(dockHeader);
    dock.appendChild(dockScroll);
    this.wrapper.appendChild(dock);
    this.excerptDockEl = dock;
  }

  /** Paste the shared in-app clipboard into the left pane when it owns focus. */
  pasteClipboardToLeft() {
    const clipboard = this.app?.clipboard;
    if (!this.enabled || !this.leftStore || !this.leftSurface || !clipboard?.length) return false;
    const box = clipboard.reduce((all, obj) => {
      const next = boundsOf(obj);
      if (!next) return all;
      if (!all) return next;
      const x = Math.min(all.x, next.x), y = Math.min(all.y, next.y);
      const right = Math.max(all.x + all.w, next.x + next.w);
      const bottom = Math.max(all.y + all.h, next.y + next.h);
      return { x, y, w: right - x, h: bottom - y };
    }, null);
    if (!box) return false;
    const view = this.leftSurface.cam.viewport(this.leftSurface.width, this.leftSurface.height);
    const center = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    const copies = this.app.cloneBatch(clipboard, center.x - (box.x + box.w / 2), center.y - (box.y + box.h / 2));
    this.leftStore.addMany(copies, 'paste');
    for (const copy of copies) {
      if (copy.excerptSource?.boardId) this.app?.recordExcerptBacklink?.(copy, this.leftStore);
    }
    this.leftSurface.selection.clear();
    for (const copy of copies) this.leftSurface.selection.add(copy.id);
    this.leftSurface.invalidate();
    this.saveLeftBoardDebounced();
    return true;
  }

  /** Public helper used by paste and automation tests to place a payload in the reference pane. */
  dropExcerptPayload(payload, event) {
    if (!this.enabled || !this.leftStore || !this.leftSurface || !event) return false;
    return this.app?.insertExcerptPayload?.(payload, this.leftSurface.toWorld(event), {
      store: this.leftStore,
      surface: this.leftSurface,
      onChange: () => this.saveLeftBoardDebounced()
    }) || false;
  }

  wireDivider(divider) {
    if (!divider) return;
    let dragging = false;

    const onPointerMove = (e) => {
      if (!dragging || !this.wrapper) return;
      const rect = this.wrapper.getBoundingClientRect();
      if (this.orientation === 'horizontal') {
        if (rect.height <= 0) return;
        const y = e.clientY - rect.top;
        this.setRatio(y / rect.height);
      } else {
        if (rect.width <= 0) return;
        const x = e.clientX - rect.left;
        this.setRatio(x / rect.width);
      }
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      try { divider.releasePointerCapture(e.pointerId); } catch {}
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { divider.setPointerCapture(e.pointerId); } catch {}
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });
  }

  /**
   * Swap left and right board documents.
   */
  async swapPanes() {
    if (!this.enabled || !this.leftStore || !this.app?.store) return;
    const leftData = this.leftStore.toJSON();
    const rightData = this.app.store.toJSON();

    const prevLeftId = this.leftBoardId || leftData.id || null;
    const prevRightId = this.app.store.doc?.id || this.app.boardId || rightData.id || null;

    this.leftStore.load(rightData);
    this.leftBoardId = prevRightId;
    if (prevLeftId) leftData.id = prevLeftId;
    this.app.loadBoard(leftData, { asCopy: false });

    if (this.pickerInput) {
      this.pickerInput.value = this.leftStore.doc?.name || this.leftStore.doc?.title || rightData.name || rightData.title || t('Untitled');
    }

    this.syncSplitTopbars();

    if (this.leftSurface) this.leftSurface.repaintAll();
    if (this.app.surface) this.app.surface.repaintAll();

    this.app?.toast?.(t('Swapped left and right boards'), 'check');
  }

  buildBoardPicker() {
    const wrap = h('div', {
      class: 'split-board-picker',
      style: 'position:relative;flex:1;max-width:280px;'
    });

    const bar = h('div', {
      class: 'split-picker-bar',
      style: 'display:flex;align-items:center;background:var(--surface,#ffffff);border:1px solid var(--line,rgba(0,0,0,0.18));border-radius:8px;padding:2px 8px;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.06);'
    });

    const searchIcon = h('span', {
      style: 'display:flex;align-items:center;opacity:0.5;color:inherit;',
      html: icon('search', 13)
    });

    this.pickerInput = h('input', {
      type: 'text',
      class: 'split-board-search-input',
      placeholder: t('Search or create board...'),
      style: 'flex:1;border:none;background:none;outline:none;font-size:12px;color:inherit;min-width:60px;padding:2px 0;'
    });

    const arrowIcon = h('span', {
      style: 'cursor:pointer;display:flex;align-items:center;opacity:0.5;color:inherit;',
      html: icon('chevronDown', 13)
    });

    bar.appendChild(searchIcon);
    bar.appendChild(this.pickerInput);
    bar.appendChild(arrowIcon);
    wrap.appendChild(bar);

    this.pickerDropdown = h('div', {
      class: 'split-picker-dropdown',
      style: 'display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:340px;overflow-y:auto;background:var(--surface,#ffffff);border:1px solid var(--line,rgba(0,0,0,0.15));border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.2);z-index:200;padding:6px;backdrop-filter:blur(20px);'
    });
    wrap.appendChild(this.pickerDropdown);

    this.pickerInput.addEventListener('focus', () => {
      this.openPickerDropdown();
    });

    this.pickerInput.addEventListener('input', () => {
      this.renderPickerList(this.pickerInput.value);
    });

    arrowIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.pickerDropdown.style.display === 'block') {
        this.closePickerDropdown();
      } else {
        this.openPickerDropdown();
        this.pickerInput.focus();
      }
    });

    this._pickerOutsideClick = (e) => {
      if (wrap && !wrap.contains(e.target)) {
        this.closePickerDropdown();
      }
    };
    window.addEventListener('pointerdown', this._pickerOutsideClick);

    return wrap;
  }

  async openPickerDropdown() {
    if (!this.pickerDropdown) return;
    this.pickerDropdown.style.display = 'block';
    await this.refreshBoardList();
    this.renderPickerList(this.pickerInput?.value || '');
  }

  closePickerDropdown() {
    if (this.pickerDropdown) this.pickerDropdown.style.display = 'none';
  }

  _cachedTabPayload(tabId) {
    if (!tabId) return null;
    const snap = this.app?.tabBar?.cache?.get?.(tabId)?.docSnapshot;
    return snap ? TabBar.docToPayload(snap) : null;
  }

  _openTabEntries() {
    const entries = [];
    const tabs = this.app?.tabBar?.tabs;
    const doc = this.app?.store?.doc;
    if (!Array.isArray(tabs)) return entries;
    for (const tab of tabs) {
      if (!tab?.id) continue;
      if (doc && tab.id === doc.id) {
        entries.push({
          id: doc.id,
          name: doc.name || tab.title || t('Untitled board'),
          objects: Object.keys(doc.objects || {}).length,
          modified: doc.modified || Date.now(),
          fromTab: true
        });
        continue;
      }
      const payload = this._cachedTabPayload(tab.id);
      entries.push({
        id: tab.id,
        name: payload?.name || tab.title || t('Untitled board'),
        objects: Array.isArray(payload?.objects) ? payload.objects.length : 0,
        modified: payload?.modified || Date.now(),
        fromTab: true,
        cachedDoc: payload
      });
    }
    return entries;
  }

  async refreshBoardList() {
    let saved = [];
    try {
      if (window.board?.boards?.list) {
        saved = await window.board.boards.list() || [];
      } else if (this.app?.storage?.list) {
        saved = await this.app.storage.list() || [];
      }
    } catch {
      saved = [];
    }
    const merged = [];
    const byId = new Map();
    for (const tabEntry of this._openTabEntries()) {
      byId.set(tabEntry.id, tabEntry);
      merged.push(tabEntry);
    }
    for (const b of (Array.isArray(saved) ? saved : [])) {
      if (!b?.id) continue;
      if (byId.has(b.id)) {
        const existing = byId.get(b.id);
        existing.thumb = existing.thumb || b.thumb;
        existing.tags = existing.tags || b.tags;
        existing.aliases = existing.aliases || b.aliases;
      } else {
        byId.set(b.id, b);
        merged.push(b);
      }
    }
    this.boardList = merged;
  }

  renderPickerList(query = '') {
    if (!this.pickerDropdown) return;
    this.pickerDropdown.innerHTML = '';
    const q = (query || '').trim().toLowerCase();

    // 1. If query is non-empty and does NOT exactly match any board title, offer "+ Create board"
    const exactMatch = this.boardList.some(b => (b.name || b.title || '').toLowerCase() === q);
    if (q && !exactMatch) {
      // The label carries the user's typed query, so it is built as DOM text:
      // `html:` would inject whatever was typed into the popover as markup.
      const createItem = h('div', {
        class: 'split-create-board-action',
        style: 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;cursor:pointer;background:rgba(0,120,212,0.08);color:#0078d4;font-size:12px;font-weight:600;margin-bottom:6px;'
      },
        h('span', { style: 'display:flex', html: icon('plus', 14) }),
        h('span', {}, t('Create board "{name}"', { name: query.trim() }))
      );
      createItem.addEventListener('pointerdown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.createNewStudyBoard(query.trim());
      });
      this.pickerDropdown.appendChild(createItem);
    }

    // 2. Filter existing boards
    const currentMainId = this.app?.store?.doc?.id || this.app?.boardId;
    const filtered = this.boardList.filter(b => {
      if (b.id && b.id === currentMainId) return false;
      if (!q) return true;
      const title = (b.name || b.title || '').toLowerCase();
      if (title.includes(q)) return true;
      const tags = Array.isArray(b.tags) ? b.tags.join(' ').toLowerCase() : '';
      if (tags.includes(q)) return true;
      const aliases = Array.isArray(b.aliases) ? b.aliases.join(' ').toLowerCase() : '';
      if (aliases.includes(q)) return true;
      return false;
    });

    if (filtered.length === 0 && (!q || exactMatch)) {
      const empty = h('div', {
        style: 'padding:12px;text-align:center;font-size:12px;color:var(--text-2,rgba(128,128,128,0.7));font-style:italic;'
      }, t('No boards found'));
      this.pickerDropdown.appendChild(empty);
      return;
    }

    for (const b of filtered) {
      const item = h('div', {
        class: 'split-board-item',
        style: 'display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:7px;cursor:pointer;transition:background 0.15s;'
      });
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(0,0,0,0.05)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });

      // Thumbnail preview
      let thumbWrap;
      if (b.thumb) {
        thumbWrap = h('div', {
          style: 'width:36px;height:24px;border-radius:4px;overflow:hidden;border:1px solid var(--line,rgba(0,0,0,0.1));background:var(--desk,#eeeeee);flex-shrink:0;display:flex;align-items:center;justify-content:center;'
        }, h('img', {
          src: b.thumb,
          style: 'width:100%;height:100%;object-fit:cover;'
        }));
      } else {
        thumbWrap = h('div', {
          style: 'width:36px;height:24px;border-radius:4px;border:1px solid var(--line,rgba(0,0,0,0.1));background:var(--desk,#eeeeee);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-2,rgba(128,128,128,0.6));',
          html: icon('doc', 14)
        });
      }

      // Title & metadata
      const titleSpan = h('div', {
        style: 'font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;color:inherit;'
      }, b.name || b.title || t('Untitled'));

      const metaParts = [];
      if (b.modified) {
        const d = new Date(b.modified);
        metaParts.push(d.toLocaleDateString());
      }
      if (Array.isArray(b.tags) && b.tags.length > 0) {
        metaParts.push(b.tags.slice(0, 2).map(tg => tg.startsWith('#') ? tg : '#' + tg).join(' '));
      }
      const metaSpan = h('div', {
        style: 'font-size:10px;color:var(--text-2,rgba(128,128,128,0.7));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;'
      }, metaParts.join(' · '));

      const infoCol = h('div', { style: 'flex:1;overflow:hidden;display:flex;flex-direction:column;gap:1px;' }, titleSpan, metaSpan);

      item.appendChild(thumbWrap);
      item.appendChild(infoCol);

      item.addEventListener('pointerdown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pickerInput.value = b.name || b.title || t('Untitled');
        this.closePickerDropdown();
        await this.loadLeftBoard(b.id);
      });

      this.pickerDropdown.appendChild(item);
    }
  }

  async loadLeftBoard(id) {
    if (!id || !this.leftStore) return;
    const currentMainId = this.app?.store?.doc?.id || this.app?.boardId;
    if (id === currentMainId) {
      this.app?.toast?.(t('A board cannot be split against itself. Please select a different board.'));
      return;
    }
    try {
      // Switching boards must not swallow the last few hundred ms of ink on
      // the board being replaced: its save is debounced, so flush it first.
      await this.flushLeftBoard();
      let data = this._cachedTabPayload(id) || this.boardList?.find((b) => b.id === id)?.cachedDoc || null;
      if (data) data = structuredClone(data);
      if (!data) {
        if (typeof window.board?.boards?.load === 'function') {
          data = await window.board.boards.load(id);
        } else if (typeof window.board?.boards?.get === 'function') {
          data = await window.board.boards.get(id);
        } else if (this.app?.storage?.load) {
          data = await this.app.storage.load(id);
        }
      }
      if (!data && this.boardList?.some((b) => b.id === id && b.fromTab)) {
        data = { id, name: this.boardList.find((b) => b.id === id)?.name || t('Untitled board'), objects: [] };
      }
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch {}
      }
      if (data) {
        if (!data.name && data.title) data.name = data.title;
        if (!Array.isArray(data.objects) && Array.isArray(data.elements)) data.objects = data.elements;
        // resolveAssets returns a new object; discarding the result left
        // `asset:` picture references unresolved and drew empty pictures.
        data = (await this.app?.resolveAssets?.(data)) || data;
        this.leftBoardId = id;
        this.leftStore.load(data);
        if (this.leftSurface) {
          this.leftSurface.cam.reset?.();
          this.leftSurface.repaintAll();
        }
        if (this.pickerInput) {
          this.pickerInput.value = data.name || data.title || t('Untitled');
        }
        if (this.leftPropertiesDialog) {
          this.leftPropertiesDialog.targetDoc = this.leftStore.doc;
          if (this.leftPropertiesDialog.visible) {
            this.leftPropertiesDialog.sync();
          }
        }
        this.syncSplitTopbars();
      }
    } catch (err) {
      this.app?.toast?.(t('Failed to load board: {msg}', { msg: err.message }));
    }
  }

  /**
   * Open a board reference (wikilink / board link "Open in Split View") in the
   * reference pane, opening the split workspace first when it is closed.
   * `ref` is `{ id, page, heading, box }` or a bare board id.
   */
  async openBoardInSplit(ref) {
    const id = typeof ref === 'string' ? ref : (ref?.id || ref?.boardId || '');
    if (!id) return false;
    // The same board on both sides would be two stores autosaving the same
    // file, each overwriting the other's strokes. Never split a board with
    // itself.
    if (id === this.app?.store?.doc?.id) {
      this.app?.toast?.(t('A board cannot be split against itself. Please select a different board.'));
      return false;
    }
    if (!this.enabled) this.enable();
    if (!this.enabled || !this.leftStore) return false;
    if (id === this.leftBoardId) {
      this.leftSurface?.repaintAll();
      if (ref && typeof ref === 'object') this.scrollLeftToRef(ref);
      return true;
    }
    await this.loadLeftBoard(id);
    if (this.leftBoardId === id && ref && typeof ref === 'object') {
      requestAnimationFrame(() => this.scrollLeftToRef(ref));
    }
    return this.leftBoardId === id;
  }

  scrollLeftToRef(ref) {
    if (!ref || !this.leftSurface?.cam || !this.leftStore?.doc) return false;
    const sf = this.leftSurface;
    if (ref.box && sf.width && sf.height) {
      sf.cam.glideTo(ref.box, sf.width, sf.height, { duration: 400 });
      sf.invalidate();
      return true;
    }
    if (ref.page > 0 && Array.isArray(this.leftStore.doc.pages) && this.leftStore.doc.pages.length) {
      const rects = pageRects(this.leftStore.doc.pages);
      const idx = Math.max(0, Math.min(rects.length - 1, (ref.page | 0) - 1));
      const r = rects[idx];
      if (r && sf.width && sf.height) {
        sf.cam.fit({ x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 }, sf.width, sf.height);
        sf.clampCamera();
        sf.invalidate();
        return true;
      }
    }
    return false;
  }

  async createNewStudyBoard(title) {
    if (!title || !title.trim()) return;
    const name = title.trim();
    const id = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newDoc = {
      schema: 2,
      v: 2,
      id,
      name,
      title: name,
      created: Date.now(),
      modified: Date.now(),
      objects: [],
      elements: [],
      pages: [{ id: 'p_1', x: 0, y: 0, w: 1920, h: 1080 }],
      properties: { tags: [], aliases: [] }
    };
    try {
      if (window.board?.boards?.save) {
        // Critical: setLast: false ensures the user's primary startup board pointer is preserved!
        await window.board.boards.save({ id, json: JSON.stringify(newDoc), setLast: false });
      }
      this.leftBoardId = id;
      if (this.leftStore) {
        this.leftStore.load(newDoc);
        if (this.leftSurface) {
          this.leftSurface.cam.reset?.();
          this.leftSurface.repaintAll();
        }
      }
      if (this.pickerInput) this.pickerInput.value = name;
      this.closePickerDropdown();
      if (this.leftPropertiesDialog) {
        this.leftPropertiesDialog.targetDoc = this.leftStore.doc;
        if (this.leftPropertiesDialog.visible) {
          this.leftPropertiesDialog.sync();
        }
      }
      this.app?.toast?.(t('Created study board "{name}"', { name }), 'check');
    } catch (err) {
      this.app?.toast?.(t('Failed to create board: {msg}', { msg: err.message }));
    }
  }

  saveLeftBoardDebounced() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveLeftBoard(), 600);
  }

  /**
   * Write the reference board out. The document is snapshotted here, before
   * anything async, because the left pane can load another board (or be torn
   * down) while the write is still in flight. Writes are chained, never
   * overlapped, so an old save cannot land after a newer one.
   */
  saveLeftBoard() {
    const boardId = this.leftBoardId;
    const store = this.leftStore;
    if (!boardId || !store) return Promise.resolve();
    let doc;
    try { doc = store.toJSON(); } catch { return Promise.resolve(); }
    doc.id = boardId;
    if (!doc.name && this.pickerInput?.value?.trim()) {
      doc.name = this.pickerInput.value.trim();
    }
    if (doc.name) doc.title = doc.name;
    const prev = this._leftSave || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._writeLeftBoard(doc, boardId));
    this._leftSave = run;
    run.finally(() => { if (this._leftSave === run) this._leftSave = null; }).catch(() => {});
    return run.catch(() => {});
  }

  /** Write any pending change now (board switch, closing the split). */
  async flushLeftBoard() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (this._leftSave) await this._leftSave.catch(() => {});
    await this.saveLeftBoard();
  }

  async _writeLeftBoard(doc, boardId) {
    try {
      await this.app?.externaliseAssets?.(doc);
      const json = JSON.stringify(doc);
      if (window.board?.boards?.save) {
        await window.board.boards.save({ id: boardId, json, setLast: false });
      }
    } catch (err) {
      console.warn('Failed to auto-save left study board:', err);
    }
  }

  syncScrollUI() {
    if (!this.btnSyncScroll) return;
    const syncActive = !!this.app?.settings?.splitSyncScroll;
    this.btnSyncScroll.classList.toggle('active', syncActive);
    this.btnSyncScroll.setAttribute('aria-pressed', String(syncActive));
    this.btnSyncScroll.style.background = syncActive ? 'rgba(0,120,212,0.14)' : 'none';
    this.btnSyncScroll.style.color = syncActive ? 'var(--accent,#0078d4)' : 'inherit';
  }

  syncCameraFromLeft() {
    if (!this.enabled || !this.app?.settings?.splitSyncScroll || this._syncingCam) return;
    const src = this.leftSurface?.cam;
    const dst = this.app?.surface?.cam;
    if (!src || !dst) return;
    this._syncingCam = true;
    try {
      dst.x = src.x;
      dst.y = src.y;
      dst.z = src.z;
      this.app.surface?.clampCamera?.();
      this.app.surface?.invalidate?.();
    } finally {
      this._syncingCam = false;
    }
  }

  syncCameraFromRight() {
    if (!this.enabled || !this.app?.settings?.splitSyncScroll || this._syncingCam) return;
    const src = this.app?.surface?.cam;
    const dst = this.leftSurface?.cam;
    if (!src || !dst) return;
    this._syncingCam = true;
    try {
      dst.x = src.x;
      dst.y = src.y;
      dst.z = src.z;
      this.leftSurface?.clampCamera?.();
      this.leftSurface?.invalidate?.();
    } finally {
      this._syncingCam = false;
    }
  }

  wireLeftCanvasNavigation(cLeft) {
    if (!cLeft || this.leftInteraction) return;
    cLeft.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.leftSurface) return;
      const cam = this.leftSurface.cam;
      const sp = this.leftSurface.screenPoint ? this.leftSurface.screenPoint(e) : { x: e.clientX, y: e.clientY };
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        cam.zoomAt?.(sp.x, sp.y, factor);
      } else {
        cam.panBy?.(-e.deltaX, -e.deltaY);
      }
      this.syncCameraFromLeft();
      this.leftSurface.repaintAll();
    }, { passive: false });
  }

  mountSplitTopbar() {
    if (typeof document === 'undefined') return;
    const topbar = document.getElementById('topbar');
    if (!topbar) return;

    this.unmountSplitTopbar();

    // 1. Left top bar section directly above the left pane
    const splitLeft = h('div', {
      id: 'splitTopbarLeft',
      class: 'split-topbar-left',
      style: `height:100%;display:flex;align-items:center;gap:6px;width:${(this.ratio * 100).toFixed(1)}%;padding:0 8px;border-right:2px solid var(--accent,#0078d4);flex-shrink:0;overflow-x:auto;scrollbar-width:none;box-sizing:border-box;background:var(--surface,#ffffff);`
    });

    const leftBadge = h('span', {
      class: 'badge split-left-badge',
      style: 'font-weight:700;font-size:11px;background:rgba(0,120,212,0.12);color:var(--accent,#0078d4);border-color:rgba(0,120,212,0.3);flex-shrink:0;'
    }, t('Left board'));

    const titleInput = h('input', {
      class: 'split-topbar-title',
      value: this.leftStore?.doc?.name || this.leftStore?.doc?.title || t('Untitled'),
      spellcheck: 'false',
      title: t('Left board name (Edit or click to rename)'),
      style: 'border:1px solid transparent;background:transparent;border-radius:6px;padding:3px 6px;font-size:14px;font-weight:600;color:var(--text);min-width:80px;max-width:200px;text-overflow:ellipsis;flex-shrink:0;'
    });
    titleInput.addEventListener('change', () => {
      const val = titleInput.value.trim() || t('Untitled');
      if (this.leftStore?.doc) {
        this.leftStore.doc.name = val;
        this.leftStore.doc.title = val;
        this.saveLeftBoardDebounced();
      }
      if (this.pickerInput) this.pickerInput.value = val;
    });
    titleInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') titleInput.blur();
    });
    this.splitLeftTitleInput = titleInput;

    const btnProps = h('button', {
      class: 'tb-btn tb-props-btn split-left-props',
      title: t('Board Properties — Left Board'),
      style: 'display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:10px;font-size:11.5px;cursor:pointer;flex-shrink:0;background:rgba(0,0,0,0.04);border:1px solid var(--line,rgba(0,0,0,0.15));color:inherit;'
    },
      h('span', { style: 'font-weight:700;color:var(--accent,#0078d4);' }, '#'),
      h('span', {}, t('Properties'))
    );
    btnProps.addEventListener('click', () => {
      if (!this.leftStore?.doc) return;
      if (!this.leftPropertiesDialog) {
        this.leftPropertiesDialog = new PropertiesDialog(this.app, {
          doc: this.leftStore.doc,
          onSave: async () => {
            await this.saveLeftBoard();
            this.syncSplitTopbars();
          }
        });
      } else {
        this.leftPropertiesDialog.targetDoc = this.leftStore.doc;
      }
      this.leftPropertiesDialog.open();
    });

    const chips = h('div', {
      class: 'split-left-props-chips',
      style: 'display:inline-flex;align-items:center;gap:4px;max-width:240px;overflow-x:auto;scrollbar-width:none;flex-shrink:0;'
    });
    this.splitLeftChips = chips;

    const btnSwap = h('button', {
      class: 'tb-btn split-left-swap-btn',
      title: t('Swap left and right boards'),
      style: 'display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:8px;font-size:11.5px;font-weight:700;cursor:pointer;flex-shrink:0;background:rgba(0,120,212,0.14);border:1px solid var(--accent,#0078d4);color:var(--accent,#0078d4);'
    },
      h('span', { style: 'font-size:13px;' }, '⇄'),
      h('span', {}, t('Swap'))
    );
    btnSwap.addEventListener('click', () => this.swapPanes());

    const btnClose = h('button', {
      class: 'tb-btn split-left-close-btn',
      title: t('Close split view'),
      style: 'display:inline-flex;align-items:center;padding:3px 6px;border-radius:6px;cursor:pointer;flex-shrink:0;background:none;border:none;color:var(--text-2);',
      html: icon('close', 14)
    });
    btnClose.addEventListener('click', () => this.disable());

    splitLeft.appendChild(leftBadge);
    splitLeft.appendChild(titleInput);
    splitLeft.appendChild(btnProps);
    splitLeft.appendChild(chips);
    splitLeft.appendChild(btnSwap);
    splitLeft.appendChild(btnClose);

    topbar.insertBefore(splitLeft, topbar.firstChild);
    this.splitTopbarLeft = splitLeft;

    // 2. Right board badge inserted right before #boardTitle
    const boardTitle = document.getElementById('boardTitle');
    if (boardTitle && boardTitle.parentNode) {
      const rightBadge = h('span', {
        id: 'splitTopbarRightBadge',
        class: 'badge split-right-badge',
        style: 'font-weight:700;font-size:11px;background:rgba(16,185,129,0.12);color:#059669;border-color:rgba(16,185,129,0.3);flex-shrink:0;'
      }, t('Right board'));
      boardTitle.parentNode.insertBefore(rightBadge, boardTitle);
      this.splitTopbarRightBadge = rightBadge;
    }

    this.syncSplitTopbars();
  }

  unmountSplitTopbar() {
    if (this.splitTopbarLeft) {
      this.splitTopbarLeft.remove();
      this.splitTopbarLeft = null;
    }
    if (this.splitTopbarRightBadge) {
      this.splitTopbarRightBadge.remove();
      this.splitTopbarRightBadge = null;
    }
    this.splitLeftTitleInput = null;
    this.splitLeftChips = null;
  }

  syncSplitTopbars() {
    if (!this.enabled) return;
    if (this.splitTopbarLeft) {
      this.splitTopbarLeft.style.width = `${(this.ratio * 100).toFixed(1)}%`;
    }
    const doc = this.leftStore?.doc;
    if (this.splitLeftTitleInput && doc) {
      this.splitLeftTitleInput.value = doc.name || doc.title || t('Untitled');
    }
    if (this.splitLeftChips && doc) {
      this.splitLeftChips.innerHTML = '';
      const tags = Array.isArray(doc.properties?.tags) ? doc.properties.tags : (Array.isArray(doc.tags) ? doc.tags : []);
      const aliases = Array.isArray(doc.properties?.aliases) ? doc.properties.aliases : (Array.isArray(doc.aliases) ? doc.aliases : []);

      for (const al of aliases.slice(0, 2)) {
        const chip = h('span', {
          class: 'prop-chip top-alias-chip',
          title: t('Board alias (Click to edit)'),
          style: 'cursor:pointer;font-size:11px;padding:2px 7px;border-radius:10px;background:rgba(168,85,247,0.14);color:#9333ea;font-weight:600;display:inline-flex;align-items:center;gap:3px;flex-shrink:0;'
        }, h('span', { style: 'font-size:10px;opacity:0.85;' }, '🏷️'), al);
        chip.addEventListener('click', () => {
          if (!this.leftPropertiesDialog) {
            this.leftPropertiesDialog = new PropertiesDialog(this.app, {
              doc: this.leftStore.doc,
              onSave: async () => {
                await this.saveLeftBoard();
                this.syncSplitTopbars();
              }
            });
          } else {
            this.leftPropertiesDialog.targetDoc = this.leftStore.doc;
          }
          this.leftPropertiesDialog.open();
        });
        this.splitLeftChips.appendChild(chip);
      }
      if (aliases.length > 2) {
        this.splitLeftChips.appendChild(h('span', { style: 'font-size:10px;color:var(--text-2);' }, `+${aliases.length - 2}`));
      }

      for (const tg of tags.slice(0, 2)) {
        const chip = h('span', {
          class: 'prop-chip top-tag-chip',
          title: t('Board tag (Click to edit)'),
          style: 'cursor:pointer;font-size:11px;padding:2px 7px;border-radius:10px;background:rgba(0,120,212,0.12);color:var(--accent-2,#0078d4);font-weight:600;display:inline-flex;align-items:center;gap:3px;flex-shrink:0;'
        }, `#${String(tg).replace(/^#+/, '')}`);
        chip.addEventListener('click', () => {
          if (!this.leftPropertiesDialog) {
            this.leftPropertiesDialog = new PropertiesDialog(this.app, {
              doc: this.leftStore.doc,
              onSave: async () => {
                await this.saveLeftBoard();
                this.syncSplitTopbars();
              }
            });
          } else {
            this.leftPropertiesDialog.targetDoc = this.leftStore.doc;
          }
          this.leftPropertiesDialog.open();
        });
        this.splitLeftChips.appendChild(chip);
      }
      if (tags.length > 2) {
        this.splitLeftChips.appendChild(h('span', { style: 'font-size:10px;color:var(--text-2);' }, `+${tags.length - 2}`));
      }
    }

    // Also update main right board title & top properties chips
    const rightTitleInput = document.getElementById('boardTitle');
    if (rightTitleInput && this.app?.store?.doc) {
      rightTitleInput.value = this.app.store.doc.name || this.app.store.doc.title || t('Untitled');
    }
  }
}
