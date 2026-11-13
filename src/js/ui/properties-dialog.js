// Board Properties Dialog (Obsidian-style tags & aliases manager).
// Allows viewing and editing tags, hierarchical tags (#main/sub/sub2), aliases, and metadata.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

export class PropertiesDialog {
  constructor(app, opts = {}) {
    this.app = app;
    this.targetDoc = opts.doc || null;
    this.onCustomSave = opts.onSave || null;
    this.el = null;
    this.visible = false;
    this.tagListEl = null;
    this.aliasListEl = null;
    this.inputTag = null;
    this.inputAlias = null;
  }

  get doc() {
    return this.targetDoc || this.app?.store?.doc;
  }

  build() {
    if (this.el) return;

    const titleText = this.targetDoc ? t('Board Properties — Study Board') : t('Board Properties');
    const title = h('span', { style: 'font-weight:700;font-size:15px;' }, titleText);
    const btnClose = h('button', {
      style: 'background:none;border:none;cursor:pointer;padding:4px;color:var(--text-2,rgba(128,128,128,0.8));display:flex;',
      html: icon('close', 18)
    });
    btnClose.addEventListener('click', () => this.close());

    const header = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--line,rgba(0,0,0,0.08));'
    }, title, btnClose);

    this.allTags = [];
    this.allAliases = [];

    // Section 1: Tags
    this.tagListEl = h('div', {
      style: 'display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;'
    });

    this.tagSuggestionsEl = h('div', {
      class: 'tag-suggestions',
      style: 'display:none;position:absolute;top:100%;left:0;right:0;z-index:1000;background:var(--surface,#ffffff);border:1px solid var(--line,rgba(0,0,0,0.15));border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.18);max-height:140px;overflow-y:auto;padding:4px;margin-top:2px;'
    });

    this.inputTag = h('input', {
      type: 'text',
      placeholder: t('Add tag (e.g. #study, #AI/ML)...'),
      style: 'width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--line,rgba(0,0,0,0.15));border-radius:10px;font-size:13px;background:var(--desk,#f5f5f7);color:inherit;outline:none;'
    });

    const updateTagSuggestions = () => {
      const q = (this.inputTag.value || '').trim().toLowerCase().replace(/^#/, '');
      this.tagSuggestionsEl.innerHTML = '';
      if (!q) {
        this.tagSuggestionsEl.style.display = 'none';
        return;
      }
      const matches = this.allTags.filter((t) => t.toLowerCase().replace(/^#/, '').includes(q));
      if (!matches.length) {
        this.tagSuggestionsEl.style.display = 'none';
        return;
      }
      for (const m of matches.slice(0, 8)) {
        const item = h('div', {
          style: 'padding:6px 10px;cursor:pointer;border-radius:6px;font-size:12.5px;font-weight:600;color:#0078d4;'
        }, m);
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(0,120,212,0.1)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.addTag(m);
          this.inputTag.value = '';
          this.tagSuggestionsEl.style.display = 'none';
        });
        this.tagSuggestionsEl.appendChild(item);
      }
      this.tagSuggestionsEl.style.display = 'block';
    };

    this.inputTag.addEventListener('input', updateTagSuggestions);
    this.inputTag.addEventListener('focus', updateTagSuggestions);
    this.inputTag.addEventListener('blur', () => {
      setTimeout(() => { if (this.tagSuggestionsEl) this.tagSuggestionsEl.style.display = 'none'; }, 200);
    });

    this.inputTag.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const firstMatch = this.tagSuggestionsEl.firstChild?.textContent;
        const val = this.inputTag.value.trim();
        this.addTag(val || firstMatch);
        this.inputTag.value = '';
        this.tagSuggestionsEl.style.display = 'none';
      }
    });

    const tagInputWrap = h('div', { style: 'position:relative;' }, this.inputTag, this.tagSuggestionsEl);

    const secTags = h('div', { style: 'margin-top:14px;' },
      h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-2,rgba(128,128,128,0.85));' }, t('Tags')),
      this.tagListEl,
      tagInputWrap
    );

    // Section 2: Aliases
    this.aliasListEl = h('div', {
      style: 'display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;'
    });

    this.aliasSuggestionsEl = h('div', {
      class: 'alias-suggestions',
      style: 'display:none;position:absolute;top:100%;left:0;right:0;z-index:1000;background:var(--surface,#ffffff);border:1px solid var(--line,rgba(0,0,0,0.15));border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.18);max-height:140px;overflow-y:auto;padding:4px;margin-top:2px;'
    });

    this.inputAlias = h('input', {
      type: 'text',
      placeholder: t('Add alias (e.g. Lecture 4 Notes)...'),
      style: 'width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--line,rgba(0,0,0,0.15));border-radius:10px;font-size:13px;background:var(--desk,#f5f5f7);color:inherit;outline:none;'
    });

    const updateAliasSuggestions = () => {
      const q = (this.inputAlias.value || '').trim().toLowerCase();
      this.aliasSuggestionsEl.innerHTML = '';
      if (!q) {
        this.aliasSuggestionsEl.style.display = 'none';
        return;
      }
      const matches = this.allAliases.filter((a) => a.toLowerCase().includes(q));
      if (!matches.length) {
        this.aliasSuggestionsEl.style.display = 'none';
        return;
      }
      for (const m of matches.slice(0, 8)) {
        const item = h('div', {
          style: 'padding:6px 10px;cursor:pointer;border-radius:6px;font-size:12.5px;font-weight:600;color:#9333ea;'
        }, m);
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(168,85,247,0.12)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.addAlias(m);
          this.inputAlias.value = '';
          this.aliasSuggestionsEl.style.display = 'none';
        });
        this.aliasSuggestionsEl.appendChild(item);
      }
      this.aliasSuggestionsEl.style.display = 'block';
    };

    this.inputAlias.addEventListener('input', updateAliasSuggestions);
    this.inputAlias.addEventListener('focus', updateAliasSuggestions);
    this.inputAlias.addEventListener('blur', () => {
      setTimeout(() => { if (this.aliasSuggestionsEl) this.aliasSuggestionsEl.style.display = 'none'; }, 200);
    });

    this.inputAlias.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const firstMatch = this.aliasSuggestionsEl.firstChild?.textContent;
        const val = this.inputAlias.value.trim();
        this.addAlias(val || firstMatch);
        this.inputAlias.value = '';
        this.aliasSuggestionsEl.style.display = 'none';
      }
    });

    const aliasInputWrap = h('div', { style: 'position:relative;' }, this.inputAlias, this.aliasSuggestionsEl);

    const secAliases = h('div', { style: 'margin-top:16px;' },
      h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-2,rgba(128,128,128,0.85));' }, t('Aliases')),
      this.aliasListEl,
      aliasInputWrap
    );

    // Section 3: Metadata Info
    this.metaEl = h('div', {
      style: 'margin-top:16px;padding-top:12px;border-top:1px solid var(--line,rgba(0,0,0,0.08));font-size:11.5px;color:var(--text-2,rgba(128,128,128,0.8));display:flex;flex-direction:column;gap:4px;'
    });

    const card = h('div', {
      class: 'properties-card',
      style: 'position:relative;width:400px;max-width:90vw;background:var(--surface,#ffffff);border-radius:18px;box-shadow:0 16px 36px rgba(0,0,0,0.2);border:1px solid var(--line,rgba(0,0,0,0.12));padding:18px 20px;'
    }, header, secTags, secAliases, this.metaEl);

    this.el = h('div', {
      id: 'propertiesModal',
      style: 'position:fixed;inset:0;z-index:var(--z-modal, 60);background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);display:none;align-items:flex-start;justify-content:center;padding-top:12vh;'
    }, card);

    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });

    document.body.appendChild(this.el);
  }

  sync() {
    if (!this.tagListEl || !this.aliasListEl) return;
    const doc = this.doc;
    if (!doc) return;

    doc.properties = doc.properties || {};
    const tags = Array.isArray(doc.properties.tags) ? doc.properties.tags : (Array.isArray(doc.tags) ? doc.tags : []);
    const aliases = Array.isArray(doc.properties.aliases) ? doc.properties.aliases : (Array.isArray(doc.aliases) ? doc.aliases : []);

    // Render tags
    this.tagListEl.innerHTML = '';
    if (tags.length === 0) {
      this.tagListEl.appendChild(h('span', { style: 'font-size:12px;color:var(--text-2,rgba(128,128,128,0.6));font-style:italic;' }, t('No tags yet')));
    } else {
      for (const tg of tags) {
        const removeBtn = h('span', {
          style: 'cursor:pointer;margin-left:4px;font-weight:700;opacity:0.7;',
          title: t('Remove')
        }, '×');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeTag(tg);
        });

        const pill = h('span', {
          style: 'display:inline-flex;align-items:center;background:rgba(0,120,212,0.1);color:#0078d4;font-size:12px;font-weight:600;padding:3px 8px;border-radius:12px;'
        }, tg, removeBtn);
        this.tagListEl.appendChild(pill);
      }
    }

    // Render aliases
    this.aliasListEl.innerHTML = '';
    if (aliases.length === 0) {
      this.aliasListEl.appendChild(h('span', { style: 'font-size:12px;color:var(--text-2,rgba(128,128,128,0.6));font-style:italic;' }, t('No aliases yet')));
    } else {
      for (const al of aliases) {
        const removeBtn = h('span', {
          style: 'cursor:pointer;margin-left:4px;font-weight:700;opacity:0.7;',
          title: t('Remove')
        }, '×');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeAlias(al);
        });

        const pill = h('span', {
          style: 'display:inline-flex;align-items:center;background:rgba(168,85,247,0.12);color:#9333ea;font-size:12px;font-weight:600;padding:3px 8px;border-radius:12px;'
        }, al, removeBtn);
        this.aliasListEl.appendChild(pill);
      }
    }

    // Metadata
    const tracks = doc.audioTracks?.length || 0;
    this.metaEl.innerHTML = '';
    this.metaEl.appendChild(h('div', {}, h('strong', {}, `${t('Board ID')}: `), String(doc.id || 'N/A')));
    this.metaEl.appendChild(h('div', {}, h('strong', {}, `${t('Audio Recordings')}: `), String(tracks)));
  }

  async addTag(raw) {
    if (!raw || !raw.trim()) return;
    const tag = raw.trim().startsWith('#') ? raw.trim() : '#' + raw.trim();
    const doc = this.doc;
    if (!doc) return;

    doc.properties = doc.properties || {};
    doc.properties.tags = Array.isArray(doc.properties.tags) ? doc.properties.tags : [];
    if (!doc.properties.tags.includes(tag)) {
      doc.properties.tags.push(tag);
      doc.tags = doc.properties.tags;
      await this.save();
    }
  }

  async removeTag(tag) {
    const doc = this.doc;
    if (!doc || !doc.properties?.tags) return;
    doc.properties.tags = doc.properties.tags.filter((t) => t !== tag);
    doc.tags = doc.properties.tags;
    await this.save();
  }

  async addAlias(raw) {
    if (!raw || !raw.trim()) return;
    const alias = raw.trim();
    const doc = this.doc;
    if (!doc) return;

    doc.properties = doc.properties || {};
    doc.properties.aliases = Array.isArray(doc.properties.aliases) ? doc.properties.aliases : [];
    if (!doc.properties.aliases.includes(alias)) {
      doc.properties.aliases.push(alias);
      doc.aliases = doc.properties.aliases;
      await this.save();
    }
  }

  async removeAlias(alias) {
    const doc = this.doc;
    if (!doc || !doc.properties?.aliases) return;
    doc.properties.aliases = doc.properties.aliases.filter((a) => a !== alias);
    doc.aliases = doc.properties.aliases;
    await this.save();
  }

  async loadWorkspaceSuggestions() {
    try {
      if (window.board?.boards?.list) {
        const list = await window.board.boards.list();
        const tagSet = new Set();
        const aliasSet = new Set();
        for (const b of list) {
          if (Array.isArray(b.tags)) b.tags.forEach((t) => tagSet.add(t));
          if (Array.isArray(b.aliases)) b.aliases.forEach((a) => aliasSet.add(a));
        }
        this.allTags = Array.from(tagSet);
        this.allAliases = Array.from(aliasSet);
      }
    } catch {}
  }

  async save() {
    this.sync();
    try {
      if (typeof this.onCustomSave === 'function') {
        await this.onCustomSave(this.doc);
      } else {
        if (typeof this.app?.persist === 'function') {
          await this.app.persist();
        }
        if (typeof this.app?.updateTopProperties === 'function') {
          this.app.updateTopProperties();
        }
      }
      this.app?.toast?.(t('Properties saved'));
    } catch (err) {
      this.app?.toast?.(t('Failed to save properties: {msg}', { msg: err.message }));
    }
  }

  async open() {
    this.build();
    this.sync();
    await this.loadWorkspaceSuggestions();
    this.visible = true;
    this.el.style.display = 'flex';
    setTimeout(() => this.inputTag?.focus(), 50);
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
    if (this.el) this.el.style.display = 'none';
  }

  toggle() {
    if (this.visible) this.close();
    else this.open();
  }
}
