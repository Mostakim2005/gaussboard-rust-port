/**
 * PDF Book Reader Sidebar & Navigation Drawer for GazBoard.
 * Provides hierarchical Table of Contents (TOC), page thumbnail strip,
 * and active-recall Study Tape index with 1-click reveal/conceal controls.
 */

import { h } from './popover.js';
import { t } from '../i18n.js';

export class PdfSidebarDrawer {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.isOpen = false;
    this.activeTab = 'toc'; // 'toc' | 'pages' | 'tape'
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    this.isOpen = true;
    this.render();
    this.app?.updateHudLayout?.('pdfSidebar');
  }

  close() {
    this.isOpen = false;
    if (this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    this.app?.updateHudLayout?.();
  }

  render() {
    if (this.el) this.el.remove();
    if (this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }

    const titleEl = h('div', { style: 'font-weight:700;font-size:14px;color:var(--text, #fff);display:flex;align-items:center;gap:8px;' },
      h('span', { style: 'color:#00e5ff;' }, '📖'),
      h('span', {}, t('Document Navigator'))
    );

    const closeBtn = h('button', {
      class: 'btn btn-ghost',
      style: 'padding:2px 8px;font-size:14px;line-height:1;',
      title: t('Close sidebar')
    }, '✕');
    closeBtn.addEventListener('click', () => this.close());

    const header = h('div', {
      style: 'padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.1);'
    }, titleEl, closeBtn);

    // Tab buttons
    const tabToc = h('button', {
      class: `btn btn-ghost ${this.activeTab === 'toc' ? 'active' : ''}`,
      style: `flex:1;padding:6px 4px;font-size:11px;border-bottom:2px solid ${this.activeTab === 'toc' ? '#00e5ff' : 'transparent'};border-radius:0;`
    }, t('TOC / Outline'));
    tabToc.addEventListener('click', () => { this.activeTab = 'toc'; this.render(); });

    const tabBookmarks = h('button', {
      class: `btn btn-ghost ${this.activeTab === 'bookmarks' ? 'active' : ''}`,
      style: `flex:1;padding:6px 4px;font-size:11px;border-bottom:2px solid ${this.activeTab === 'bookmarks' ? '#00e5ff' : 'transparent'};border-radius:0;`
    }, t('Bookmarks'));
    tabBookmarks.addEventListener('click', () => { this.activeTab = 'bookmarks'; this.render(); });

    const tabPages = h('button', {
      class: `btn btn-ghost ${this.activeTab === 'pages' ? 'active' : ''}`,
      style: `flex:1;padding:6px 4px;font-size:11px;border-bottom:2px solid ${this.activeTab === 'pages' ? '#00e5ff' : 'transparent'};border-radius:0;`
    }, t('Pages'));
    tabPages.addEventListener('click', () => { this.activeTab = 'pages'; this.render(); });

    const tabTape = h('button', {
      class: `btn btn-ghost ${this.activeTab === 'tape' ? 'active' : ''}`,
      style: `flex:1;padding:6px 4px;font-size:11px;border-bottom:2px solid ${this.activeTab === 'tape' ? '#00e5ff' : 'transparent'};border-radius:0;`
    }, t('Study Index'));
    tabTape.addEventListener('click', () => { this.activeTab = 'tape'; this.render(); });

    const tabNav = h('div', {
      style: 'display:flex;background:rgba(0,0,0,0.2);border-bottom:1px solid rgba(255,255,255,0.08);'
    }, tabToc, tabBookmarks, tabPages, tabTape);

    // Content container
    const body = h('div', {
      style: 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;'
    });

    if (this.activeTab === 'toc') {
      this.renderToc(body);
    } else if (this.activeTab === 'bookmarks') {
      this.renderBookmarks(body);
    } else if (this.activeTab === 'pages') {
      this.renderPages(body);
    } else {
      this.renderStudyTapeIndex(body);
    }

    this.el = h('div', {
      class: 'pdf-sidebar modal-glass',
      style: 'position:fixed;top:48px;left:0;bottom:0;width:310px;z-index:var(--z-drawer, 35);display:flex;flex-direction:column;background:rgba(18,22,28,0.92);backdrop-filter:blur(16px);border-right:1px solid rgba(255,255,255,0.12);box-shadow:4px 0 24px rgba(0,0,0,0.4);animation:slideRight 0.2s cubic-bezier(0.16,1,0.3,1);'
    }, header, tabNav, body);

    document.body.appendChild(this.el);

    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this.close();
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  renderToc(container) {
    const pages = this.app.store?.doc?.pages || [];
    const outline = this.app.store?.doc?.pdfOutline;

    // Search filter input
    const searchWrap = h('div', { style: 'margin-bottom:8px;' });
    const searchInput = h('input', {
      type: 'text',
      placeholder: t('Search outline…'),
      value: this.tocFilter || '',
      style: 'width:100%;box-sizing:border-box;padding:6px 10px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#eee;font-size:12px;'
    });

    const listWrap = h('div', { class: 'pdf-toc-list', style: 'display:flex;flex-direction:column;gap:2px;' });

    const updateList = () => {
      listWrap.innerHTML = '';
      const query = this.tocFilter || '';

      if (Array.isArray(outline) && outline.length) {
        const renderOutlineTree = (items, depth = 0) => {
          for (const item of items) {
            const title = item.title || t('Section');
            const isMatch = !query || title.toLowerCase().includes(query);
            const hasChildren = Array.isArray(item.items) && item.items.length > 0;

            if (isMatch || hasChildren) {
              const row = h('div', {
                style: `padding:6px 8px;padding-left:${depth * 14 + 8}px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);transition:background 0.15s;margin-bottom:2px;`
              },
                h('div', { style: 'display:flex;align-items:center;gap:6px;overflow:hidden;' },
                  h('span', { style: 'font-size:11px;color:rgba(255,255,255,0.5);' }, hasChildren ? '▼' : '•'),
                  h('span', { style: 'font-size:12px;color:var(--text,#eee);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, title)
                ),
                h('span', { style: 'font-size:11px;color:#00e5ff;flex-shrink:0;' }, `p. ${item.pageNumber || 1}`)
              );
              row.addEventListener('mouseenter', () => row.style.background = 'rgba(0,229,255,0.12)');
              row.addEventListener('mouseleave', () => row.style.background = 'rgba(255,255,255,0.04)');
              row.addEventListener('click', () => {
                const targetPage = item.pageNumber ? Math.max(0, Math.min(Math.max(0, pages.length - 1), item.pageNumber - 1)) : 0;
                this.app.jumpToPage?.(targetPage);
              });
              listWrap.appendChild(row);
            }

            if (hasChildren) {
              renderOutlineTree(item.items, depth + 1);
            }
          }
        };

        renderOutlineTree(outline, 0);
        return;
      }

      // Fallback: Generate Outline from Page numbers & headings on each page
      if (!pages.length) {
        listWrap.appendChild(h('div', {
          style: 'color:var(--text-3,rgba(255,255,255,0.5));font-size:13px;text-align:center;padding:24px;'
        }, t('Single-page canvas (No PDF outline)')));
        return;
      }

      pages.forEach((p, idx) => {
        const pageTitle = p.title || `${t('Page')} ${idx + 1}`;
        if (query && !pageTitle.toLowerCase().includes(query)) return;
        const row = h('div', {
          style: 'padding:8px 10px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);margin-bottom:2px;'
        },
          h('span', { style: 'font-size:13px;color:var(--text,#eee);' }, pageTitle),
          h('span', { style: 'font-size:11px;color:#00e5ff;' }, `→`)
        );
        row.addEventListener('mouseenter', () => row.style.background = 'rgba(0,229,255,0.12)');
        row.addEventListener('mouseleave', () => row.style.background = 'rgba(255,255,255,0.04)');
        row.addEventListener('click', () => {
          this.app.jumpToPage?.(idx);
        });
        listWrap.appendChild(row);
      });
    };

    searchInput.addEventListener('input', (e) => {
      this.tocFilter = e.target.value.toLowerCase().trim();
      updateList();
    });

    searchWrap.appendChild(searchInput);
    container.appendChild(searchWrap);
    container.appendChild(listWrap);
    updateList();
  }

  renderBookmarks(container) {
    if (!this.app.store?.doc) return;
    this.app.store.doc.bookmarks = this.app.store.doc.bookmarks || [];
    const bookmarks = this.app.store.doc.bookmarks;

    const addBtn = h('button', {
      class: 'btn btn-primary',
      style: 'width:100%;margin-bottom:12px;padding:7px;font-size:12px;display:flex;align-items:center;justify-content:center;gap:6px;'
    }, '+ ', t('Bookmark current view'));

    addBtn.addEventListener('click', () => {
      const curPage = this.app.currentPageIndex?.() || 0;
      const defaultName = `${t('Bookmark')} ${bookmarks.length + 1} (${t('Page')} ${curPage + 1})`;
      const name = window.prompt(t('Enter bookmark title:'), defaultName);
      if (!name) return;

      const bm = {
        id: 'bm_' + Date.now(),
        title: name.trim(),
        pageIndex: curPage,
        cam: this.app.surface?.cam ? {
          x: this.app.surface.cam.x,
          y: this.app.surface.cam.y,
          z: this.app.surface.cam.z
        } : null,
        created: Date.now()
      };
      bookmarks.push(bm);
      this.app.store._touch?.();
      this.render();
      this.app.toast?.(t('Bookmark added'));
    });
    container.appendChild(addBtn);

    if (!bookmarks.length) {
      container.appendChild(h('div', {
        style: 'color:var(--text-3,rgba(255,255,255,0.5));font-size:13px;text-align:center;padding:24px;'
      }, t('No bookmarks saved yet. Click above to bookmark key pages or views.')));
      return;
    }

    bookmarks.forEach((bm, idx) => {
      const row = h('div', {
        style: 'padding:8px 10px;border-radius:6px;display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);margin-bottom:4px;'
      },
        h('div', {
          style: 'flex:1;cursor:pointer;overflow:hidden;',
          title: t('Click to jump to bookmark')
        },
          h('div', { style: 'font-size:13px;color:#eee;font-weight:600;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;' }, bm.title),
          h('div', { style: 'font-size:11px;color:rgba(255,255,255,0.45);' }, `${t('Page')} ${(bm.pageIndex || 0) + 1}`)
        ),
        h('button', {
          class: 'btn btn-ghost',
          style: 'padding:2px 6px;color:#ff6b6b;font-size:13px;',
          title: t('Delete bookmark')
        }, '🗑️')
      );

      row.children[0].addEventListener('click', () => {
        this.app.jumpToPage?.(bm.pageIndex || 0);
        if (bm.cam && this.app.surface?.cam) {
          this.app.surface.cam.x = bm.cam.x;
          this.app.surface.cam.y = bm.cam.y;
          this.app.surface.cam.z = bm.cam.z;
          this.app.surface.damageAll();
        }
      });

      row.children[1].addEventListener('click', () => {
        bookmarks.splice(idx, 1);
        this.app.store._touch?.();
        this.render();
      });

      container.appendChild(row);
    });
  }

  renderPages(container) {
    const pages = this.app.store?.doc?.pages || [];
    const currentIdx = this.app.currentPageIndex?.() || 0;

    const addPageBtn = h('button', {
      class: 'btn btn-primary',
      style: 'width:100%;margin-bottom:8px;padding:6px;font-size:12px;'
    }, t('+ Add new page'));
    addPageBtn.addEventListener('click', () => {
      this.app.command?.('page.add');
      this.render();
    });
    container.appendChild(addPageBtn);

    pages.forEach((p, idx) => {
      const isActive = idx === currentIdx;
      const card = h('div', {
        style: `padding:10px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:${isActive ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.04)'};border:1px solid ${isActive ? '#00e5ff' : 'rgba(255,255,255,0.1)'};`
      },
        h('div', { style: 'display:flex;align-items:center;gap:8px;' },
          h('span', { style: `font-size:12px;font-weight:700;color:${isActive ? '#00e5ff' : 'inherit'};` }, `${idx + 1}`),
          h('span', { style: 'font-size:13px;' }, p.title || `${t('Page')} ${idx + 1}`)
        ),
        h('div', { style: 'font-size:11px;color:var(--text-3,rgba(255,255,255,0.5));' },
          `${Math.round(p.w || 800)}×${Math.round(p.h || 1100)}`
        )
      );

      card.addEventListener('click', () => {
        this.app.jumpToPage?.(idx);
        this.render();
      });
      container.appendChild(card);
    });
  }

  renderStudyTapeIndex(container) {
    const objects = this.app.store?.doc?.objects || {};
    const tapes = Object.values(objects).filter(o => o && o.type === 'curtain');

    const actionRow = h('div', { style: 'display:flex;gap:8px;margin-bottom:8px;' },
      h('button', {
        class: 'btn btn-ghost',
        style: 'flex:1;padding:6px;font-size:11px;border:1px solid rgba(255,255,255,0.15);'
      }, t('Reveal All')),
      h('button', {
        class: 'btn btn-ghost',
        style: 'flex:1;padding:6px;font-size:11px;border:1px solid rgba(255,255,255,0.15);'
      }, t('Conceal All'))
    );

    actionRow.children[0].addEventListener('click', () => {
      this.app.revealAllCurtains?.();
      this.render();
    });
    actionRow.children[1].addEventListener('click', () => {
      this.app.coverAllCurtains?.();
      this.render();
    });
    container.appendChild(actionRow);

    if (!tapes.length) {
      container.appendChild(h('div', {
        style: 'color:var(--text-3,rgba(255,255,255,0.5));font-size:13px;text-align:center;padding:24px;'
      }, t('No study tape or answer covers on this board.')));
      return;
    }

    tapes.forEach((tape, i) => {
      const isRevealed = !!tape.revealed;
      const isFreehand = tape.subtype === 'tape';
      const row = h('div', {
        style: 'padding:8px 10px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);'
      },
        h('div', { style: 'display:flex;align-items:center;gap:6px;' },
          h('span', {}, isRevealed ? '👁️' : '🙈'),
          h('span', { style: 'font-size:12px;' }, `${isFreehand ? t('Study Tape') : t('Answer Cover')} #${i + 1}`)
        ),
        h('span', {
          style: `font-size:11px;font-weight:600;color:${isRevealed ? '#51cf66' : '#ffd94a'};`
        }, isRevealed ? t('Revealed') : t('Concealed'))
      );

      row.addEventListener('click', () => {
        // Toggle this curtain
        this.app.toggleCurtain?.(tape.id);
        this.render();
      });
      container.appendChild(row);
    });
  }
}
