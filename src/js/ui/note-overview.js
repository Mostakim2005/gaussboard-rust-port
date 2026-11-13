// Note Overview Drawer & Document Outline.
// Shows note previews, tags, aliases, interactive infinite canvas mini-map with viewport window,
// multi-page thumbnail strip, and quick actions (Open, Split View, Create Quick Note).

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { boundsOf } from '../core/store.js';
import { drawObject } from '../core/render.js';
import { pageRects } from '../core/pages.js';

export class NoteOverviewDrawer {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.visible = false;
    this.boards = [];
    this.activeTab = 'overview'; // 'overview' | 'boards'
    this.cardsContainer = null;
    this.overviewContainer = null;
    this.boardsWrapper = null;
    this.searchInput = null;
    this.tabOverviewBtn = null;
    this.tabBoardsBtn = null;
    this._miniMapCanvas = null;
    this._miniMapTransform = null;
  }

  async loadBoards() {
    try {
      if (window.board?.boards?.list) {
        this.boards = await window.board.boards.list();
      }
    } catch {
      this.boards = [];
    }
  }

  build() {
    if (this.el) return;

    // Header
    const title = h('span', { style: 'font-weight:700;font-size:16px;' }, t('Note overview'));
    const btnClose = h('button', {
      style: 'background:none;border:none;cursor:pointer;padding:4px;color:var(--text-2,rgba(128,128,128,0.8));display:flex;',
      html: icon('close', 18)
    });
    btnClose.addEventListener('click', () => this.close());

    const header = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px 10px;border-bottom:1px solid var(--line,rgba(128,128,128,0.12));'
    }, title, btnClose);

    // Tab Navigation Bar: [ Overview ] and [ My boards ]
    this.tabOverviewBtn = h('button', {
      class: 'note-tab-btn active',
      style: 'flex:1;padding:8px 12px;border:none;background:none;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--accent-2,#0078d4);border-bottom:2px solid var(--accent-2,#0078d4);transition:all 0.15s;'
    }, t('Note overview'));

    this.tabBoardsBtn = h('button', {
      class: 'note-tab-btn',
      style: 'flex:1;padding:8px 12px;border:none;background:none;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text-2,rgba(128,128,128,0.8));border-bottom:2px solid transparent;transition:all 0.15s;'
    }, t('My boards'));

    this.tabOverviewBtn.addEventListener('click', () => this.switchTab('overview'));
    this.tabBoardsBtn.addEventListener('click', () => this.switchTab('boards'));

    const tabNav = h('div', {
      style: 'display:flex;background:var(--surface-2,rgba(128,128,128,0.06));border-bottom:1px solid var(--line,rgba(128,128,128,0.12));'
    }, this.tabOverviewBtn, this.tabBoardsBtn);

    // 1. Overview Container (Canvas Mini-Map or Page Thumbnails)
    this.overviewContainer = h('div', {
      class: 'note-overview-content',
      style: 'flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:12px;'
    });

    // 2. Boards Gallery View
    this.searchInput = h('input', {
      type: 'text',
      placeholder: t('Search notes, tags, aliases...'),
      style: 'width:100%;box-sizing:border-box;padding:10px 14px 10px 36px;border:none;background:var(--desk,rgba(128,128,128,0.1));border-radius:10px;font-size:13.5px;color:var(--text,inherit);outline:none;'
    });
    const searchIcon = h('span', {
      style: 'position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-2,rgba(128,128,128,0.7));display:flex;pointer-events:none;',
      html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
    });
    const searchWrap = h('div', {
      style: 'position:relative;padding:12px 18px 8px;'
    }, searchIcon, this.searchInput);

    this.searchInput.addEventListener('input', () => this.filter());

    this.cardsContainer = h('div', {
      class: 'note-overview-cards',
      style: 'flex:1;overflow-y:auto;padding:6px 18px;'
    });

    const btnCreate = h('button', {
      class: 'btn-create-quick-note',
      style: 'width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border:none;background:none;cursor:pointer;color:var(--accent-2,#0078d4);font-weight:600;font-size:14px;border-top:1px solid var(--line,rgba(128,128,128,0.12));'
    }, h('svg', {
      viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', strokeWidth: '2'
    }), h('span', {}, t('Create quick note')));

    btnCreate.addEventListener('click', () => {
      this.close();
      if (this.app?.newBoard) {
        this.app.newBoard();
      }
    });

    this.boardsWrapper = h('div', {
      style: 'flex:1;display:none;flex-direction:column;overflow:hidden;'
    }, searchWrap, this.cardsContainer, btnCreate);

    // Slide-out Drawer Panel
    const drawer = h('div', {
      class: 'note-overview-drawer',
      style: 'position:absolute;top:0;left:0;bottom:0;width:350px;max-width:88vw;background:var(--surface,#ffffff);color:var(--text,#111111);box-shadow:6px 0 24px rgba(0,0,0,0.18);z-index:var(--z-drawer, 35);display:flex;flex-direction:column;border-right:1px solid var(--line,rgba(128,128,128,0.12));'
    }, header, tabNav, this.overviewContainer, this.boardsWrapper);

    // Backdrop
    this.el = h('div', {
      id: 'noteOverviewBackdrop',
      style: 'position:fixed;inset:0;z-index:var(--z-drawer-backdrop, 34);background:rgba(0,0,0,0.3);backdrop-filter:blur(3px);display:none;'
    }, drawer);

    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });

    document.body.appendChild(this.el);
  }

  switchTab(tab) {
    this.activeTab = tab;
    if (this.tabOverviewBtn && this.tabBoardsBtn) {
      if (tab === 'overview') {
        this.tabOverviewBtn.style.color = 'var(--accent-2,#0078d4)';
        this.tabOverviewBtn.style.borderBottomColor = 'var(--accent-2,#0078d4)';
        this.tabBoardsBtn.style.color = 'var(--text-2,rgba(128,128,128,0.8))';
        this.tabBoardsBtn.style.borderBottomColor = 'transparent';
        if (this.overviewContainer) this.overviewContainer.style.display = 'flex';
        if (this.boardsWrapper) this.boardsWrapper.style.display = 'none';
        this.renderOverview();
      } else {
        this.tabBoardsBtn.style.color = 'var(--accent-2,#0078d4)';
        this.tabBoardsBtn.style.borderBottomColor = 'var(--accent-2,#0078d4)';
        this.tabOverviewBtn.style.color = 'var(--text-2,rgba(128,128,128,0.8))';
        this.tabOverviewBtn.style.borderBottomColor = 'transparent';
        if (this.overviewContainer) this.overviewContainer.style.display = 'none';
        if (this.boardsWrapper) this.boardsWrapper.style.display = 'flex';
        this.filter();
      }
    }
  }

  async open() {
    this.build();
    await this.loadBoards();
    this.visible = true;
    this.el.style.display = 'block';
    this.switchTab(this.activeTab || 'overview');
    this.app?.updateHudLayout?.('noteOverview');
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
    if (this.el) this.el.style.display = 'none';
    this.app?.updateHudLayout?.();
  }

  toggle() {
    if (this.visible) this.close();
    else this.open();
  }

  getContentBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const objs = this.app.store?.objects || [];
    for (const o of objs) {
      if (!o || o.hidden) continue;
      const b = boundsOf(o);
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: minX - 40,
      y: minY - 40,
      w: (maxX - minX) + 80,
      h: (maxY - minY) + 80
    };
  }

  renderOverview() {
    if (!this.overviewContainer) return;
    this.overviewContainer.innerHTML = '';

    const doc = this.app.store?.doc || {};
    const title = doc.name || doc.title || t('Untitled board');
    const pages = Array.isArray(doc.pages) ? doc.pages : [];

    // 1. Current Board Title Card
    const tagPills = [];
    if (Array.isArray(doc.tags)) {
      for (const tg of doc.tags) {
        tagPills.push(h('span', {
          style: 'background:rgba(0,120,212,0.12);color:var(--accent-2,#0078d4);font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;'
        }, `#${String(tg).replace(/^#+/, '')}`));
      }
    }
    if (Array.isArray(doc.aliases)) {
      for (const al of doc.aliases) {
        tagPills.push(h('span', {
          style: 'background:rgba(168,85,247,0.14);color:#9333ea;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;display:inline-flex;align-items:center;gap:3px;'
        }, h('span', { style: 'font-size:9px;opacity:0.85;' }, '🏷️'), al));
      }
    }

    const infoCard = h('div', {
      style: 'padding:12px;border-radius:12px;background:var(--surface-2,rgba(128,128,128,0.06));border:1px solid var(--line,rgba(128,128,128,0.15));display:flex;flex-direction:column;gap:4px;'
    },
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' },
        h('span', { style: 'font-weight:700;font-size:14.5px;color:var(--text,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, title),
        h('span', { style: 'font-size:10px;padding:2px 6px;border-radius:6px;background:var(--accent-2,#0078d4);color:#ffffff;font-weight:600;' }, t('Current'))
      ),
      tagPills.length ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;' }, ...tagPills) : '',
      h('span', { style: 'font-size:11px;color:var(--text-2,rgba(128,128,128,0.8));margin-top:2px;' },
        pages.length > 0 ? `${pages.length} ${t('Pages').toLowerCase()}` : t('Infinite canvas')
      )
    );
    this.overviewContainer.appendChild(infoCard);

    // 2. Overview: If Multi-Page -> Page Thumbnails. If Infinite Canvas -> Mini-Map
    if (pages.length > 0) {
      this.renderPageThumbnails(pages);
    } else {
      this.renderInfiniteCanvasMiniMap();
    }
  }

  renderInfiniteCanvasMiniMap() {
    const miniMapSection = h('div', {
      style: 'display:flex;flex-direction:column;gap:8px;'
    });

    const secTitle = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;'
    },
      h('span', { style: 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-2,rgba(128,128,128,0.85));' }, t('Infinite canvas')),
      h('span', { style: 'font-size:11px;color:var(--text-2,rgba(128,128,128,0.7));' }, t('Pan the canvas'))
    );

    const canvas = document.createElement('canvas');
    canvas.className = 'overview-minimap-canvas';
    canvas.style.cssText = 'width:100%;height:190px;border-radius:12px;border:1.5px solid var(--line,rgba(128,128,128,0.2));cursor:crosshair;touch-action:none;display:block;background:var(--desk,rgba(128,128,128,0.08));';
    this._miniMapCanvas = canvas;

    // Controls Row: Fit to Board & Reset Zoom
    const btnFit = h('button', {
      class: 'btn',
      style: 'flex:1;padding:5px 8px;font-size:11.5px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;'
    }, t('Fit to board'));

    btnFit.addEventListener('click', () => {
      const b = this.getContentBounds();
      const sf = this.app.surface;
      if (b && sf?.cam) {
        sf.cam.fit(b, sf.width, sf.height);
        sf.clampCamera?.();
        sf.invalidate?.();
        this.paintMiniMap(canvas);
        zoomBadge.textContent = `${Math.round((sf.cam.z || 1) * 100)}%`;
      }
    });

    const btnReset = h('button', {
      class: 'btn',
      style: 'flex:1;padding:5px 8px;font-size:11.5px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;'
    }, t('Reset zoom'));

    btnReset.addEventListener('click', () => {
      const sf = this.app.surface;
      if (sf?.cam) {
        sf.cam.x = 0;
        sf.cam.y = 0;
        sf.cam.z = 1;
        sf.clampCamera?.();
        sf.invalidate?.();
        this.paintMiniMap(canvas);
        zoomBadge.textContent = '100%';
      }
    });

    const curZoom = Math.round((this.app.surface?.cam?.z || 1) * 100);
    const zoomBadge = h('span', {
      style: 'font-size:11px;font-weight:600;color:var(--text-2,rgba(128,128,128,0.8));padding:4px 8px;background:var(--surface-2,rgba(128,128,128,0.1));border-radius:6px;'
    }, `${curZoom}%`);

    const controls = h('div', {
      style: 'display:flex;align-items:center;gap:6px;'
    }, btnFit, btnReset, zoomBadge);

    miniMapSection.appendChild(secTitle);
    miniMapSection.appendChild(canvas);
    miniMapSection.appendChild(controls);
    this.overviewContainer.appendChild(miniMapSection);

    // Initial paint after DOM insertion
    requestAnimationFrame(() => {
      this.paintMiniMap(canvas);
      this.setupMiniMapEvents(canvas, zoomBadge);
    });
  }

  paintMiniMap(canvas) {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth || 314;
    const ch = canvas.clientHeight || 190;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sf = this.app.surface;
    const cam = sf?.cam || { x: 0, y: 0, z: 1 };
    const viewW = (sf?.width || 800) / cam.z;
    const viewH = (sf?.height || 600) / cam.z;
    const viewX = cam.x - viewW / 2;
    const viewY = cam.y - viewH / 2;

    let minX = viewX, minY = viewY, maxX = viewX + viewW, maxY = viewY + viewH;
    const objs = this.app.store?.objects || [];
    for (const o of objs) {
      if (!o || o.hidden) continue;
      const b = boundsOf(o);
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
    }

    const spanW = Math.max(400, maxX - minX);
    const spanH = Math.max(260, maxY - minY);
    const padX = spanW * 0.15;
    const padY = spanH * 0.15;
    const worldBox = {
      x: minX - padX,
      y: minY - padY,
      w: spanW + padX * 2,
      h: spanH + padY * 2
    };

    const s = Math.min(canvas.width / worldBox.w, canvas.height / worldBox.h);
    const ox = (canvas.width - worldBox.w * s) / 2;
    const oy = (canvas.height - worldBox.h * s) / 2;

    this._miniMapTransform = { s, ox, oy, worldBox, dpr };

    const isDark = (document.documentElement.getAttribute('data-theme') === 'dark') ||
      (window.matchMedia?.('(prefers-color-scheme: dark)').matches && document.documentElement.getAttribute('data-theme') !== 'light');

    ctx.fillStyle = isDark ? '#1a1918' : '#faf9f8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle coordinate grid / center marker
    const originX = ox + (0 - worldBox.x) * s;
    const originY = oy + (0 - worldBox.y) * s;
    if (originX >= 0 && originX <= canvas.width && originY >= 0 && originY <= canvas.height) {
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(originX - 12 * dpr, originY); ctx.lineTo(originX + 12 * dpr, originY);
      ctx.moveTo(originX, originY - 12 * dpr); ctx.lineTo(originX, originY + 12 * dpr);
      ctx.stroke();
    }

    // Draw objects in world coordinates
    ctx.save();
    ctx.setTransform(s, 0, 0, s, ox - worldBox.x * s, oy - worldBox.y * s);
    for (const o of objs) {
      if (!o || o.hidden) continue;
      try { drawObject(ctx, o); } catch {}
    }
    ctx.restore();

    // Draw Viewport Window (the camera view rectangle)
    const vx = ox + (viewX - worldBox.x) * s;
    const vy = oy + (viewY - worldBox.y) * s;
    const vw = viewW * s;
    const vh = viewH * s;

    ctx.fillStyle = 'rgba(0, 120, 212, 0.18)';
    ctx.strokeStyle = '#0078d4';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(vx, vy, vw, vh, 4 * dpr);
    } else {
      ctx.rect(vx, vy, vw, vh);
    }
    ctx.fill();
    ctx.stroke();

    // Center crosshair inside viewport
    ctx.fillStyle = '#0078d4';
    ctx.beginPath();
    ctx.arc(vx + vw / 2, vy + vh / 2, 2.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  setupMiniMapEvents(canvas, zoomBadge) {
    let isDragging = false;

    const navigateToMapPoint = (clientX, clientY) => {
      if (!this._miniMapTransform) return;
      const { s, ox, oy, worldBox, dpr } = this._miniMapTransform;
      const rect = canvas.getBoundingClientRect();
      const px = (clientX - rect.left) * dpr;
      const py = (clientY - rect.top) * dpr;

      const wx = worldBox.x + (px - ox) / s;
      const wy = worldBox.y + (py - oy) / s;

      const sf = this.app.surface;
      if (sf?.cam) {
        sf.cam.x = wx;
        sf.cam.y = wy;
        sf.clampCamera?.();
        sf.invalidate?.();
        this.paintMiniMap(canvas);
        if (zoomBadge) zoomBadge.textContent = `${Math.round((sf.cam.z || 1) * 100)}%`;
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      isDragging = true;
      canvas.setPointerCapture(e.pointerId);
      navigateToMapPoint(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (isDragging) {
        navigateToMapPoint(e.clientX, e.clientY);
      }
    });

    const endDrag = (e) => {
      if (isDragging) {
        isDragging = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
      }
    };

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  renderPageThumbnails(pages) {
    const pagesSection = h('div', {
      style: 'display:flex;flex-direction:column;gap:10px;'
    });

    const currentIdx = typeof this.app.currentPageIndex === 'function' ? this.app.currentPageIndex() : 0;
    const rects = pageRects(pages);

    const headerRow = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;margin-top:4px;'
    },
      h('span', { style: 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-2,rgba(128,128,128,0.85));' }, `${t('Pages')} (${pages.length})`),
      h('button', {
        class: 'btn',
        style: 'padding:3px 8px;font-size:11px;border-radius:6px;cursor:pointer;'
      }, t('+ Add new page'))
    );

    headerRow.children[1].addEventListener('click', () => {
      this.app.command?.('page.add');
      this.renderOverview();
    });

    pagesSection.appendChild(headerRow);

    const listContainer = h('div', {
      style: 'display:flex;flex-direction:column;gap:10px;'
    });

    pages.forEach((p, idx) => {
      const isCurrent = idx === currentIdx;
      const r = rects[idx] || { x: 0, y: 0, w: p.w || 800, h: p.h || 1100 };

      const card = h('div', {
        class: 'note-page-thumbnail-card',
        style: `padding:10px;border-radius:10px;cursor:pointer;background:var(--surface-2,rgba(128,128,128,0.06));border:2px solid ${isCurrent ? 'var(--accent-2,#0078d4)' : 'var(--line,rgba(128,128,128,0.15))'};display:flex;flex-direction:column;gap:6px;transition:all 0.15s;`
      },
        h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' },
          h('div', { style: 'display:flex;align-items:center;gap:6px;' },
            h('span', { style: `font-size:12px;font-weight:700;color:${isCurrent ? 'var(--accent-2,#0078d4)' : 'inherit'};` }, `${t('Page')} ${idx + 1}`),
            isCurrent ? h('span', { style: 'font-size:9.5px;padding:1px 5px;background:var(--accent-2,#0078d4);color:#ffffff;border-radius:4px;font-weight:600;' }, t('Current')) : ''
          ),
          h('div', { style: 'display:flex;align-items:center;gap:6px;' },
            h('span', { style: 'font-size:10.5px;color:var(--text-2,rgba(128,128,128,0.8));' }, `${Math.round(p.w || 800)} × ${Math.round(p.h || 1100)}`),
            pages.length > 1 ? (() => {
              const b = h('button', {
                class: 'icon-btn page-thumb-del',
                title: t('Delete page {n}', { n: idx + 1 }),
                style: 'background:none;border:none;cursor:pointer;color:var(--text-2);padding:1px 4px;border-radius:4px;font-size:12px;'
              }, '🗑️');
              b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.app.deletePage(idx);
                this.renderOverview();
              });
              return b;
            })() : ''
          )
        )
      );

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:150px;border-radius:8px;display:block;background:var(--desk,rgba(128,128,128,0.08));';
      card.appendChild(canvas);

      card.addEventListener('mouseenter', () => {
        if (!isCurrent) card.style.background = 'var(--surface-2, rgba(128,128,128,0.14))';
      });
      card.addEventListener('mouseleave', () => {
        if (!isCurrent) card.style.background = 'var(--surface-2, rgba(128,128,128,0.06))';
      });

      card.addEventListener('click', () => {
        if (typeof this.app.fitToPage === 'function') {
          this.app.fitToPage(idx);
        } else if (typeof this.app.jumpToPage === 'function') {
          this.app.jumpToPage(idx);
        }
        this.renderOverview();
      });

      listContainer.appendChild(card);

      requestAnimationFrame(() => {
        this.paintPageThumb(canvas, idx, r, p);
      });
    });

    pagesSection.appendChild(listContainer);
    this.overviewContainer.appendChild(pagesSection);
  }

  paintPageThumb(canvas, pageIndex, rect, page) {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth || 300;
    const ch = canvas.clientHeight || 150;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isDark = (document.documentElement.getAttribute('data-theme') === 'dark') ||
      (window.matchMedia?.('(prefers-color-scheme: dark)').matches && document.documentElement.getAttribute('data-theme') !== 'light');

    ctx.fillStyle = isDark ? '#1a1918' : '#f0f0f4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const pad = 10 * dpr;
    const s = Math.min((canvas.width - pad * 2) / rect.w, (canvas.height - pad * 2) / rect.h);
    const ox = (canvas.width - rect.w * s) / 2;
    const oy = (canvas.height - rect.h * s) / 2;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);

    // Sheet background with drop shadow
    ctx.fillStyle = this.app.store?.doc?.background?.color || (isDark ? '#252423' : '#ffffff');
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 8 / s;
    ctx.shadowOffsetY = 2 / s;
    ctx.fillRect(0, 0, rect.w, rect.h);
    ctx.shadowColor = 'transparent';

    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1 / s;
    ctx.strokeRect(0, 0, rect.w, rect.h);

    // Clip to page sheet
    ctx.beginPath();
    ctx.rect(0, 0, rect.w, rect.h);
    ctx.clip();

    // Draw objects on this page (translate from world space)
    ctx.translate(-rect.x, -rect.y);
    const objs = this.app.store?.objects || [];
    for (const o of objs) {
      if (!o || o.hidden) continue;
      const b = boundsOf(o);
      if (!b) continue;
      if (b.x + b.w >= rect.x && b.x <= rect.x + rect.w &&
          b.y + b.h >= rect.y && b.y <= rect.y + rect.h) {
        try { drawObject(ctx, o); } catch {}
      }
    }
    ctx.restore();
  }

  filter() {
    const q = (this.searchInput?.value || '').trim().toLowerCase();
    this.renderCards(q);
  }

  renderCards(q) {
    if (!this.cardsContainer) return;
    this.cardsContainer.innerHTML = '';

    const currentDoc = this.app?.store?.doc;
    const currentId = currentDoc?.id;

    const matched = this.boards.filter((b) => {
      if (!q) return true;
      const titleMatch = (b.name || b.title || '').toLowerCase().includes(q);
      const aliasMatch = Array.isArray(b.aliases) && b.aliases.some((a) => a.toLowerCase().includes(q));
      const tagMatch = Array.isArray(b.tags) && b.tags.some((t) => t.toLowerCase().includes(q));
      return titleMatch || aliasMatch || tagMatch;
    });

    if (matched.length === 0) {
      this.cardsContainer.appendChild(h('div', {
        style: 'text-align:center;padding:30px 10px;color:var(--text-2,rgba(128,128,128,0.8));font-size:13px;'
      }, t('No notes found')));
      return;
    }

    for (const b of matched) {
      const isCurrent = b.id === currentId;
      const title = b.name || b.title || t('Untitled');
      const ts = b.modified || b.updated;
      const dateStr = ts ? new Date(ts).toLocaleDateString() : '';

      // Card thumbnail
      const thumbUrl = b.thumb || (isCurrent ? this.app?.boardPictureFor?.() : null);
      let thumb;
      if (thumbUrl) {
        thumb = h('div', {
          class: 'note-card-thumb',
          style: 'height:120px;border-radius:10px;background:var(--desk,rgba(128,128,128,0.08));border:1px solid var(--line,rgba(128,128,128,0.15));display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;'
        }, h('img', {
          src: thumbUrl,
          alt: title,
          style: 'width:100%;height:100%;object-fit:cover;display:block;'
        }));
      } else {
        thumb = h('div', {
          class: 'note-card-thumb',
          style: 'height:120px;border-radius:10px;background:var(--desk,rgba(128,128,128,0.08));border:1px solid var(--line,rgba(128,128,128,0.15));display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;'
        }, h('svg', {
          viewBox: '0 0 24 24', width: '36', height: '36', fill: 'none', stroke: 'rgba(128,128,128,0.5)', strokeWidth: '1.5',
          html: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'
        }));
      }

      // Tag pills
      const tagPills = [];
      if (Array.isArray(b.tags)) {
        for (const tg of b.tags) {
          tagPills.push(h('span', {
            style: 'background:rgba(0,120,212,0.12);color:var(--accent-2,#0078d4);font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;margin-right:4px;'
          }, `#${String(tg).replace(/^#+/, '')}`));
        }
      }

      // Alias pills
      const aliasPills = [];
      if (Array.isArray(b.aliases)) {
        for (const al of b.aliases) {
          aliasPills.push(h('span', {
            style: 'background:rgba(168,85,247,0.14);color:#9333ea;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;margin-right:4px;display:inline-flex;align-items:center;gap:3px;'
          }, h('span', { style: 'font-size:9px;opacity:0.85;' }, '🏷️'), al));
        }
      }

      // Action buttons: Split View, Add Tag, Add Alias
      const btnSplit = h('button', {
        class: 'btn-note-split',
        title: t('Open in Split View'),
        style: 'background:var(--desk,rgba(128,128,128,0.1));border:1px solid var(--line,rgba(128,128,128,0.15));cursor:pointer;padding:3px 6px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--text,inherit);transition:background 0.15s;',
        html: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>'
      });
      btnSplit.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.close();
        if (!this.app.splitWorkspace) return;
        const currentMainId = this.app.store?.doc?.id || this.app.boardId;
        if (b.id === currentMainId) {
          this.app.toast(t('A board cannot be split against itself. Please select a different board.'));
          return;
        }
        if (!this.app.splitWorkspace.enabled) {
          await this.app.splitWorkspace.enable({ leftBoardId: b.id });
        } else {
          await this.app.splitWorkspace.loadLeftBoard(b.id);
        }
      });

      const btnTag = h('button', {
        class: 'btn-note-tag',
        title: t('Add Tag...'),
        style: 'background:rgba(0,120,212,0.1);border:1px solid rgba(0,120,212,0.25);cursor:pointer;padding:3px 6px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:#0078d4;font-size:11px;font-weight:700;transition:background 0.15s;',
        html: '<span style="font-size:12px;font-weight:800;line-height:1;">#</span>'
      });
      btnTag.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addTagToBoard(b);
      });

      const btnAlias = h('button', {
        class: 'btn-note-alias',
        title: t('Add Alias...'),
        style: 'background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.25);cursor:pointer;padding:3px 6px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:#9333ea;font-size:11px;font-weight:700;transition:background 0.15s;',
        html: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>'
      });
      btnAlias.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addAliasToBoard(b);
      });

      const actionsWrap = h('div', {
        class: 'note-card-actions',
        style: 'display:flex;align-items:center;gap:4px;'
      }, btnSplit, btnTag, btnAlias);

      const isLongName = (title || '').length > 18;
      const titleRow = isLongName
        ? h('div', { style: 'margin-top:8px;display:flex;flex-direction:column;gap:4px;' },
            h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' },
              h('span', { style: 'font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;color:var(--text,inherit);', title }, title),
              actionsWrap
            ),
            h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;' }, ...tagPills, ...aliasPills),
            h('span', { style: 'font-size:11px;color:var(--text-2,rgba(128,128,128,0.8));margin-top:2px;' }, dateStr)
          )
        : h('div', { style: 'margin-top:8px;display:flex;align-items:flex-start;justify-content:space-between;' },
            h('div', { style: 'display:flex;flex-direction:column;gap:2px;overflow:hidden;' },
              h('span', { style: 'font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text,inherit);', title }, title),
              h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;' }, ...tagPills, ...aliasPills),
              h('span', { style: 'font-size:11px;color:var(--text-2,rgba(128,128,128,0.8));margin-top:2px;' }, dateStr)
            ),
            actionsWrap
          );

      const card = h('div', {
        class: 'note-overview-card',
        title: t('Double-click to open board'),
        style: `margin-bottom:16px;cursor:pointer;padding:8px;border-radius:12px;border:1.5px solid ${isCurrent ? 'var(--accent-2,#0078d4)' : 'transparent'};transition:background 0.15s, border-color 0.15s;color:var(--text,inherit);`
      },
        thumb,
        titleRow
      );

      const openThisBoard = () => {
        this.close();
        if (!isCurrent) {
          if (typeof this.app?.openBoardRef === 'function') {
            this.app.openBoardRef({ id: b.id, name: b.name || b.title });
          } else if (typeof this.app?.openBoard === 'function') {
            this.app.openBoard(b.id);
          }
        }
      };

      card.addEventListener('mouseenter', () => { card.style.background = 'var(--surface-2, rgba(128,128,128,0.12))'; });
      card.addEventListener('mouseleave', () => { card.style.background = 'transparent'; });
      card.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openThisBoard();
      });

      this.cardsContainer.appendChild(card);
    }
  }

  showInputModal(title, placeholder, defaultValue = '') {
    return new Promise((resolve) => {
      const backdrop = h('div', {
        class: 'note-overview-modal-backdrop',
        style: 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;'
      });

      const input = h('input', {
        type: 'text',
        value: defaultValue,
        placeholder,
        style: 'width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--line,rgba(128,128,128,0.2));background:var(--desk,rgba(128,128,128,0.1));border-radius:8px;font-size:13px;color:var(--text,inherit);outline:none;margin-top:8px;'
      });

      const btnCancel = h('button', {
        class: 'btn',
        style: 'padding:5px 12px;font-size:12px;border-radius:8px;cursor:pointer;'
      }, t('Cancel'));

      const btnSubmit = h('button', {
        class: 'btn primary',
        style: 'padding:5px 14px;font-size:12px;border-radius:8px;cursor:pointer;'
      }, t('Add'));

      const finish = (val) => {
        backdrop.remove();
        resolve(val);
      };

      btnCancel.addEventListener('click', () => finish(null));
      btnSubmit.addEventListener('click', () => finish(input.value.trim()));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value.trim());
        if (e.key === 'Escape') finish(null);
      });
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) finish(null);
      });

      const box = h('div', {
        style: 'width:320px;max-width:90vw;background:var(--surface,#ffffff);color:var(--text,#111111);border:1px solid var(--line,rgba(128,128,128,0.2));border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,0.3);padding:16px;display:flex;flex-direction:column;gap:10px;'
      },
        h('span', { style: 'font-weight:700;font-size:14px;' }, title),
        input,
        h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px;' }, btnCancel, btnSubmit)
      );

      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      setTimeout(() => input.focus(), 50);
    });
  }

  async addTagToBoard(board) {
    const tag = await this.showInputModal(t('Add tag to board'), t('Enter tag name (e.g. #study or #ai/llm)'));
    if (!tag || !tag.trim()) return;
    const cleaned = tag.trim().startsWith('#') ? tag.trim() : '#' + tag.trim();

    try {
      let raw = null;
      if (window.board?.boards?.load) {
        raw = await window.board.boards.load(board.id);
      }
      if (typeof raw === 'string') raw = JSON.parse(raw);
      if (!raw) return;

      raw.properties = raw.properties || {};
      raw.properties.tags = Array.isArray(raw.properties.tags) ? raw.properties.tags : [];
      if (!raw.properties.tags.includes(cleaned)) {
        raw.properties.tags.push(cleaned);
      }
      raw.tags = raw.properties.tags;

      if (window.board?.boards?.save) {
        await window.board.boards.save({
          id: board.id,
          json: JSON.stringify(raw),
          setLast: this.app?.store?.doc?.id === board.id
        });
      }
      if (this.app?.store?.doc?.id === board.id) {
        this.app.store.doc.properties = this.app.store.doc.properties || {};
        this.app.store.doc.properties.tags = raw.properties.tags;
        this.app.store.doc.tags = raw.tags;
        if (typeof this.app.persist === 'function') await this.app.persist();
        if (typeof this.app.updateTopProperties === 'function') this.app.updateTopProperties();
      }
      await this.loadBoards();
      this.filter();
      this.app?.toast?.(t('Tag {tag} added', { tag: cleaned }));
    } catch (err) {
      this.app?.toast?.(t('Failed to add tag: {msg}', { msg: err.message }));
    }
  }

  async addAliasToBoard(board) {
    const alias = await this.showInputModal(t('Add alias to board'), t('Enter alias for board (e.g. Lecture 4 Notes)'));
    if (!alias || !alias.trim()) return;
    const cleaned = alias.trim();

    try {
      let raw = null;
      if (window.board?.boards?.load) {
        raw = await window.board.boards.load(board.id);
      }
      if (typeof raw === 'string') raw = JSON.parse(raw);
      if (!raw) return;

      raw.properties = raw.properties || {};
      raw.properties.aliases = Array.isArray(raw.properties.aliases) ? raw.properties.aliases : [];
      if (!raw.properties.aliases.includes(cleaned)) {
        raw.properties.aliases.push(cleaned);
      }
      raw.aliases = raw.properties.aliases;

      if (window.board?.boards?.save) {
        await window.board.boards.save({
          id: board.id,
          json: JSON.stringify(raw),
          setLast: this.app?.store?.doc?.id === board.id
        });
      }
      if (this.app?.store?.doc?.id === board.id) {
        this.app.store.doc.properties = this.app.store.doc.properties || {};
        this.app.store.doc.properties.aliases = raw.properties.aliases;
        this.app.store.doc.aliases = raw.aliases;
        if (typeof this.app.persist === 'function') await this.app.persist();
        if (typeof this.app.updateTopProperties === 'function') this.app.updateTopProperties();
      }
      await this.loadBoards();
      this.filter();
      this.app?.toast?.(t('Alias “{alias}” added', { alias: cleaned }));
    } catch (err) {
      this.app?.toast?.(t('Failed to add alias: {msg}', { msg: err.message }));
    }
  }
}
