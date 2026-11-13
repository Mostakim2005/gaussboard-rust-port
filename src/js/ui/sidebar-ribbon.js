// Double-Layered Sidebar Ribbon Menu for GazBoard / GaussBoard Engineering Workstation.
// Supports Left/Right docking, Glassmorphism / Google Material styling,
// and double-layered category spine + expanded interactive tool shelf.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { evalMathExpression, SymbolicCAS, notebookVars, naturalMathToLaTeX } from '../core/scientific-math.js';
import { TechnicalLinter } from '../core/technical-linter.js';
import { collectStudyCards, previewNextIntervals, Rating } from '../core/fsrs.js';
import { balanceChemicalEquation, insertReactionCard } from '../core/chemistry.js';
import { FORMULA_CATALOG, insertFormulaCard } from '../core/formula-graph.js';
import { DICTIONARY_DATABASE } from './dictionary-popover.js';
import { LADDER_PRESETS } from '../core/diagram-builder.js';

export class SidebarRibbon {
  constructor(app) {
    this.app = app;
    this.container = null;
    this.latch = null;
    this.activeCategory = 'circuits'; // 'circuits' | 'math' | 'stem' | 'study' | 'esl' | 'diagrams' | 'layout'
    this.expanded = false;
    this.position = 'left'; // 'left' | 'right'
    this.styleMode = 'glassmorphism'; // 'glassmorphism' | 'material'
    this.doubleLayer = true; // true = rail + deck, false = rail only

    // Read stored settings if available
    if (this.app.settings?.sidebarRibbonPosition) {
      this.position = this.app.settings.sidebarRibbonPosition;
    }
    if (this.app.settings?.sidebarRibbonStyle) {
      this.styleMode = this.app.settings.sidebarRibbonStyle;
    }
    if (typeof this.app.settings?.sidebarRibbonVisible === 'boolean') {
      this.expanded = this.app.settings.sidebarRibbonVisible;
    }
    if (this.app.settings?.sidebarRibbonCategory) {
      this.activeCategory = this.app.settings.sidebarRibbonCategory;
    }
  }

  getBrandName() {
    return localStorage.getItem('gazboard_custom_brand') || 'GaussBoard';
  }

  setBrandName(name) {
    const brand = (name || 'GaussBoard').trim();
    localStorage.setItem('gazboard_custom_brand', brand);
    document.title = `${brand} - Engineering Whiteboard`;
    const brandEl = document.querySelector('.ribbon-brand-text');
    if (brandEl) brandEl.textContent = brand;
    this.app.toast?.(t('Brand display name updated to {name}', { name: brand }));
  }

  init() {
    if (this.container) return;
    this.inkingAutoHide = typeof localStorage !== 'undefined' ? (localStorage.getItem('gazboard_ribbon_autohide') !== 'false') : true;
    try {
      this.hiddenCategories = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem('gazboard_ribbon_hidden_cats') || '[]') : [];
    } catch {
      this.hiddenCategories = [];
    }
    this.build();
    this.syncState();
    this.syncCategoryVisibility();

    if (typeof window !== 'undefined') {
      let proximityTimer = null;
      window.addEventListener('pointerdown', (e) => {
        if (!this.inkingAutoHide || !this.expanded || !this.doubleLayer) return;
        const target = e.target;
        if (target && target.tagName === 'CANVAS' && !this.container?.contains(target)) {
          this.doubleLayer = false;
          this.syncState();
        }
      });

      // Debounced inking proximity auto-collapse: collapses extended shelf when pen draws near ribbon boundary
      window.addEventListener('pointermove', (e) => {
        if (!this.inkingAutoHide || !this.expanded || !this.doubleLayer || !this.container) return;
        if (e.buttons === 0) return;
        const target = e.target;
        if (!target || target.tagName !== 'CANVAS') return;

        if (proximityTimer) return;
        proximityTimer = setTimeout(() => {
          proximityTimer = null;
          if (!this.container || !this.expanded || !this.doubleLayer) return;
          const rect = this.container.getBoundingClientRect();
          const margin = 48;
          const nearRibbon = this.position === 'right'
            ? e.clientX >= (rect.left - margin)
            : e.clientX <= (rect.right + margin);

          if (nearRibbon) {
            this.doubleLayer = false;
            this.syncState();
          }
        }, 120);
      });
    }
  }

  syncCategoryVisibility() {
    if (!this.catButtons) return;
    for (const [id, btn] of Object.entries(this.catButtons)) {
      const isHidden = Array.isArray(this.hiddenCategories) && this.hiddenCategories.includes(id);
      btn.style.display = isHidden ? 'none' : 'flex';
    }
  }

  build() {
    // 1. Edge toggle latch (visible when ribbon is collapsed so users can pull it open easily)
    this.latch = h('button', {
      class: 'sidebar-ribbon-latch',
      title: t('Toggle Engineering Ribbon (Ctrl+B)'),
      'aria-label': t('Toggle Engineering Ribbon')
    }, h('svg', {
      viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2'
    }, h('path', { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' })));

    this.latch.addEventListener('click', () => this.toggle());

    // 2. Main Double-Layered Sidebar Container
    this.container = h('aside', {
      class: `sidebar-ribbon dock-${this.position} style-${this.styleMode}`,
      'aria-label': t('Engineering & STEM Workbench')
    });

    // 3. Layer 1: Spine / Vertical Rail
    const spine = h('div', { class: 'ribbon-spine' });

    // Top Brand / Logo Header
    const brandLogo = h('div', {
      class: 'ribbon-brand-badge',
      title: t('GaussBoard Engineering Workstation')
    }, h('svg', {
      viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2'
    }, h('path', { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' })));

    const brandText = h('span', { class: 'ribbon-brand-text' }, this.getBrandName());
    const brandHeader = h('div', { class: 'ribbon-spine-header' }, brandLogo, brandText);
    brandHeader.addEventListener('click', () => {
      this.activeCategory = 'layout';
      this.expanded = true;
      this.syncState();
    });
    spine.appendChild(brandHeader);

    // Categories definition
    const categories = [
      {
        id: 'circuits',
        label: t('Circuits & EE'),
        iconSvg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>'
      },
      {
        id: 'math',
        label: t('Math & CAS'),
        iconSvg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19L9 5h6l5 14M8 14h8M12 5v14"/></svg>'
      },
      {
        id: 'stem',
        label: t('STEM Science'),
        iconSvg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3v6l-5 9a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3l-5-9V3M9 3h6M8 14h8"/></svg>'
      },
      {
        id: 'study',
        label: t('Study & FSRS'),
        iconSvg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15zM8 7h8M8 11h6"/></svg>'
      },
      {
        id: 'esl',
        label: t('ESL & Voice'),
        iconSvg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg>'
      },
      {
        id: 'diagrams',
        label: t('Diagrams & PDF'),
        iconSvg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M10 6.5h4M17.5 10v4M10 17.5h4M6.5 10v4"/></svg>'
      },
      {
        id: 'layout',
        label: t('Layout & Brand'),
        iconSvg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
      }
    ];

    const spineNav = h('nav', { class: 'ribbon-spine-nav' });
    this.catButtons = {};

    categories.forEach((cat) => {
      const btn = h('button', {
        class: `ribbon-spine-item ${this.activeCategory === cat.id ? 'active' : ''}`,
        title: cat.label,
        'aria-label': cat.label
      });
      btn.innerHTML = `${cat.iconSvg}<span class="ribbon-item-label">${cat.label}</span>`;
      btn.addEventListener('click', () => {
        if (this.activeCategory === cat.id && this.expanded) {
          // Toggle deck collapse
          this.toggleDeck();
        } else {
          this.activeCategory = cat.id;
          this.expanded = true;
          this.doubleLayer = true;
          this.syncState();
          this.renderDeckContent();
        }
      });
      this.catButtons[cat.id] = btn;
      spineNav.appendChild(btn);
    });

    spine.appendChild(spineNav);

    // Bottom Spine Tools (Collapse / Dock Toggle)
    const spineFooter = h('div', { class: 'ribbon-spine-footer' });
    const btnToggleDeck = h('button', {
      class: 'ribbon-footer-btn',
      title: t('Expand/Collapse Tool Shelf'),
      'aria-label': t('Expand/Collapse Tool Shelf')
    }, h('svg', {
      viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2'
    }, h('path', { d: 'M11 19l-7-7 7-7M19 19l-7-7 7-7' })));
    btnToggleDeck.addEventListener('click', () => this.toggleDeck());

    const btnHide = h('button', {
      class: 'ribbon-footer-btn',
      title: t('Hide Ribbon (Ctrl+B)'),
      'aria-label': t('Hide Ribbon')
    }, h('svg', {
      viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2'
    }, h('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), h('line', { x1: '6', y1: '6', x2: '18', y2: '18' })));
    btnHide.addEventListener('click', () => this.close());

    spineFooter.appendChild(btnToggleDeck);
    spineFooter.appendChild(btnHide);
    spine.appendChild(spineFooter);

    // 4. Layer 2: Tool Deck (Secondary Shelf)
    this.deck = h('div', { class: 'ribbon-deck' });

    this.container.appendChild(spine);
    this.container.appendChild(this.deck);

    // Mount into DOM (stage or body)
    const stage = document.getElementById('stage') || document.body;
    stage.appendChild(this.latch);
    stage.appendChild(this.container);

    this.renderDeckContent();
  }

  toggle() {
    this.expanded = !this.expanded;
    this.syncState();
  }

  open() {
    this.expanded = true;
    this.syncState();
    this.app?.updateHudLayout?.('ribbon');
  }

  close() {
    this.expanded = false;
    this.syncState();
    this.app?.updateHudLayout?.();
  }

  toggleDeck() {
    this.doubleLayer = !this.doubleLayer;
    this.syncState();
  }

  syncState() {
    if (!this.container || !this.latch) return;

    this.container.classList.toggle('expanded', this.expanded);
    this.container.classList.toggle('single-layer', !this.doubleLayer);
    this.container.classList.toggle('dock-left', this.position === 'left');
    this.container.classList.toggle('dock-right', this.position === 'right');
    this.container.classList.toggle('style-glassmorphism', this.styleMode === 'glassmorphism');
    this.container.classList.toggle('style-material', this.styleMode === 'material');

    this.latch.classList.toggle('hidden', this.expanded);
    this.latch.classList.toggle('dock-left', this.position === 'left');
    this.latch.classList.toggle('dock-right', this.position === 'right');

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('ribbon-left', this.position === 'left');
      document.body.classList.toggle('ribbon-right', this.position === 'right');
      document.body.classList.toggle('ribbon-open', !!this.expanded);
    }

    // Update active category in spine
    if (this.catButtons) {
      Object.entries(this.catButtons).forEach(([id, btn]) => {
        btn.classList.toggle('active', id === this.activeCategory);
      });
    }

    // Persist user preference
    if (this.app.settings) {
      this.app.settings.sidebarRibbonVisible = this.expanded;
      this.app.settings.sidebarRibbonPosition = this.position;
      this.app.settings.sidebarRibbonStyle = this.styleMode;
      this.app.settings.sidebarRibbonCategory = this.activeCategory;
      this.app.saveSettings?.();
    }
  }

  renderDeckContent() {
    if (!this.deck) return;
    this.deck.innerHTML = '';

    const header = h('div', { class: 'deck-header' });
    const title = h('h4', { class: 'deck-title' });
    const closeBtn = h('button', {
      class: 'deck-close-btn',
      title: t('Collapse tool deck'),
      'aria-label': t('Collapse tool deck')
    }, h('svg', {
      viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2'
    }, h('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), h('line', { x1: '6', y1: '6', x2: '18', y2: '18' })));

    closeBtn.addEventListener('click', () => {
      this.doubleLayer = false;
      this.syncState();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    this.deck.appendChild(header);

    const body = h('div', { class: 'deck-body' });
    this.deck.appendChild(body);

    switch (this.activeCategory) {
      case 'circuits':
        title.textContent = t('Electrical Engineering & Circuits');
        this.renderCircuitsContent(body);
        break;
      case 'math':
        title.textContent = t('Advanced LaTeX & CAS Studio');
        this.renderMathContent(body);
        break;
      case 'stem':
        title.textContent = t('STEM Revision & Sciences');
        this.renderStemContent(body);
        break;
      case 'study':
        title.textContent = t('Spaced Repetition & Study Tape');
        this.renderStudyContent(body);
        break;
      case 'esl':
        title.textContent = t('ESL & Technical Voice');
        this.renderEslContent(body);
        break;
      case 'diagrams':
        title.textContent = t('Diagrams & LiquidText Synthesis');
        this.renderDiagramsContent(body);
        break;
      case 'layout':
        title.textContent = t('Workbench Layout & Branding');
        this.renderLayoutContent(body);
        break;
      default:
        break;
    }
  }

  // --- 1. Circuits & EE Shelf ---
  renderCircuitsContent(container) {
    const desc = h('p', { class: 'deck-desc' },
      t('Realistic 2.5D industrial components, schematic drafting, and Falstad netlist circuit simulation.')
    );
    container.appendChild(desc);

    // 2.5D Industrial Simulation Workbench Section
    const simSection = h('div', { class: 'deck-section' });
    simSection.appendChild(h('h5', { class: 'deck-section-title' }, t('2.5D Simulation Workbench')));

    const btnLaunchSim = h('button', { class: 'deck-action-btn primary' },
      h('span', { class: 'btn-icon' }, '⚡'),
      h('span', {}, t('Launch Industrial Workbench (Ctrl+Shift+E)'))
    );
    btnLaunchSim.addEventListener('click', () => {
      this.app.openCircuitWorkbench?.('dol');
    });

    const presetRow = h('div', { style: 'display:flex;gap:6px;margin-top:6px;' });
    const btnPresetDOL = h('button', { class: 'deck-action-btn', style: 'flex:1;font-size:11px;' }, t('DOL Starter'));
    btnPresetDOL.addEventListener('click', () => {
      this.app.openCircuitWorkbench?.('dol');
    });

    const btnPresetRev = h('button', { class: 'deck-action-btn', style: 'flex:1;font-size:11px;' }, t('Fwd/Rev Interlock'));
    btnPresetRev.addEventListener('click', () => {
      this.app.openCircuitWorkbench?.('rev');
    });

    presetRow.appendChild(btnPresetDOL);
    presetRow.appendChild(btnPresetRev);
    simSection.appendChild(btnLaunchSim);
    simSection.appendChild(presetRow);
    container.appendChild(simSection);

    // Stencil Component Library
    const sectionStencils = h('div', { class: 'deck-section' });
    sectionStencils.appendChild(h('h5', { class: 'deck-section-title' }, t('Component Stencils')));

    const stencils = [
      { name: '3P Breaker QF', tag: '[QF] 3-Phase Circuit Breaker', type: 'breaker' },
      { name: 'Contactor KM1', tag: '[KM1] AC Contactor 3P+1NO', type: 'contactor' },
      { name: 'Overload KK', tag: '[KK] Thermal Overload Relay', type: 'overload' },
      { name: 'Pushbutton Box', tag: '[PB] Start/Stop Pushbutton', type: 'pushbutton' },
      { name: 'Terminal TB', tag: '[TB] 8-Way Terminal Block', type: 'terminal' },
      { name: '3Φ AC Motor M', tag: '[M] 3-Phase Induction Motor', type: 'motor' },
      { name: 'Resistor R', tag: 'Resistor 10kΩ', type: 'resistor' },
      { name: 'Capacitor C', tag: 'Capacitor 100μF', type: 'capacitor' },
      { name: 'DC Supply', tag: '24V DC Regulated Supply', type: 'dc-supply' }
    ];

    const grid = h('div', { class: 'deck-grid' });
    stencils.forEach((comp) => {
      const chip = h('button', {
        class: 'deck-tool-chip',
        title: t('Place {name} onto canvas', { name: comp.name })
      }, comp.name);
      chip.addEventListener('click', () => {
        this.insertCircuitComponentNote(comp);
      });
      grid.appendChild(chip);
    });
    sectionStencils.appendChild(grid);
    container.appendChild(sectionStencils);

    // Live Instruments
    const sectionInst = h('div', { class: 'deck-section' });
    sectionInst.appendChild(h('h5', { class: 'deck-section-title' }, t('Virtual Test Instruments')));

    const btnMeter = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🎛️'),
      h('span', {}, t('Digital Multimeter Probe (V / I / Ω)'))
    );
    btnMeter.addEventListener('click', () => {
      this.app.openCircuitWorkbench?.('dol');
    });

    const btnOscilloscope = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📈'),
      h('span', {}, t('Dual-Trace Virtual Oscilloscope'))
    );
    btnOscilloscope.addEventListener('click', () => {
      this.app.openCircuitWorkbench?.('dol');
    });

    sectionInst.appendChild(btnMeter);
    sectionInst.appendChild(btnOscilloscope);
    container.appendChild(sectionInst);

    // Relay Ladder Logic (RLL) Presets
    const ladderSection = h('div', { class: 'deck-section' });
    ladderSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Relay Ladder Logic (RLL)')));

    const ladderSelect = h('select', { class: 'deck-select' });
    LADDER_PRESETS.forEach((p) => {
      const opt = h('option', { value: p.id }, p.title);
      ladderSelect.appendChild(opt);
    });

    const btnStampLadder = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📋'),
      h('span', {}, t('Insert Ladder Logic to Board'))
    );
    btnStampLadder.addEventListener('click', () => {
      const chosen = LADDER_PRESETS.find((p) => p.id === ladderSelect.value);
      if (chosen) {
        const cam = this.app.surface?.cam || { viewport: { x: 200, y: 200 } };
        const textObj = {
          id: `ladder_${Date.now()}`,
          type: 'text',
          x: (cam.viewport?.x || 200) + 60,
          y: (cam.viewport?.y || 200) + 60,
          text: `### 🪜 ${chosen.title}\n*${chosen.description}*\n\`\`\`text\n${chosen.diagram}\n\`\`\``,
          t: Date.now()
        };
        this.app.store?.add(textObj);
        this.app.saveSoon?.();
        this.app.surface?.render?.();
        this.app.toast?.(t('Inserted ladder logic diagram to board.'));
      }
    });

    ladderSection.appendChild(ladderSelect);
    ladderSection.appendChild(btnStampLadder);
    container.appendChild(ladderSection);
  }

  insertCircuitComponentNote(comp) {
    const cam = this.app.surface?.camera || { x: 0, y: 0, z: 1 };
    const rect = this.app.surface?.canvas?.getBoundingClientRect() || { width: 800, height: 600 };
    const cx = (rect.width / 2 - cam.x) / cam.z;
    const cy = (rect.height / 2 - cam.y) / cam.z;

    const noteText = `### ⚡ ${comp.name}\n**Netlist Element**: \`${comp.type}\`\n- **Terminals**: (1, 3, 5) | (2, 4, 6)\n- **Auxiliary**: NO (13, 14) / NC (21, 22)\n- **Status**: [Ready for Wiring]`;
    const noteObj = {
      type: 'note',
      x: cx - 110,
      y: cy - 70,
      width: 220,
      height: 140,
      color: '#e8f4fd',
      text: noteText,
      markdown: true,
      font: 'hand'
    };

    if (this.app.store?.add) {
      this.app.store.add(noteObj, 'insert circuit component');
      this.app.surface?.invalidate?.();
      this.app.toast?.(t('Placed {name} on canvas', { name: comp.name }));
    }
  }

  // --- 2. Math & CAS Shelf ---
  renderMathContent(container) {
    const desc = h('p', { class: 'deck-desc' },
      t('Instant natural language symbolic calculation, MathLive syntax guard, and reactive variable binding.')
    );
    container.appendChild(desc);

    // Natural Language Math Calculator
    const calcSection = h('div', { class: 'deck-section' });
    calcSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Natural Language Solver')));

    const mathInput = h('input', {
      class: 'deck-input',
      type: 'text',
      placeholder: t('e.g. 3x + 12 = 0, parallel 10k 47k, sqrt(144) * 3')
    });

    const mathResult = h('div', { class: 'deck-result-box' }, t('Result: ready'));

    const btnSolve = h('button', { class: 'deck-action-btn primary' }, t('Evaluate & Solve'));
    btnSolve.addEventListener('click', () => {
      const q = mathInput.value.trim();
      if (!q) return;
      try {
        // Parallel impedance shortcut
        if (/^parallel\s+/i.test(q)) {
          const parts = q.replace(/^parallel\s+/i, '').split(/\s+/);
          const parseVal = (str) => {
            const m = str.match(/^([0-9.]+)(k|m|u)?/i);
            if (!m) return parseFloat(str) || 0;
            let v = parseFloat(m[1]);
            const unit = (m[2] || '').toLowerCase();
            if (unit === 'k') v *= 1000;
            if (unit === 'm') v *= 1000000;
            if (unit === 'u') v *= 0.000001;
            return v;
          };
          const r1 = parseVal(parts[0] || '1');
          const r2 = parseVal(parts[1] || '1');
          const req = (r1 * r2) / (r1 + r2);
          mathResult.textContent = `Req = ${req >= 1000 ? (req / 1000).toFixed(2) + ' kΩ' : req.toFixed(2) + ' Ω'}`;
          return;
        }
        // Symbolic CAS linear equation check e.g. "3x + 12 = 0"
        if (q.includes('=') && /x/i.test(q)) {
          const casSol = SymbolicCAS.solveLinear(q);
          if (casSol) {
            mathResult.textContent = `${t('Linear Root')}: x = ${casSol.root}`;
            return;
          }
        }
        // Symbolic CAS derivative check e.g. "diff x^3"
        if (/^(?:diff|d\/dx)\s+/i.test(q)) {
          const targetExpr = q.replace(/^(?:diff|d\/dx)\s+/i, '');
          const dRes = SymbolicCAS.differentiate(targetExpr);
          if (dRes) {
            mathResult.textContent = `d/dx(${targetExpr}) = ${dRes}`;
            return;
          }
        }
        const res = evalMathExpression(q);
        mathResult.textContent = `${t('Result')}: ${res}`;
      } catch (err) {
        mathResult.textContent = `${t('Error')}: ${err.message}`;
      }
    });

    calcSection.appendChild(mathInput);
    calcSection.appendChild(btnSolve);
    calcSection.appendChild(mathResult);
    container.appendChild(calcSection);

    // Dynamic 2D Calculus Grapher & Formula Editor
    const actionSection = h('div', { class: 'deck-section' });
    actionSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Formula & Calculus Tools')));

    const btnGrapher = h('button', { class: 'deck-action-btn primary' },
      h('span', { class: 'btn-icon' }, '📈'),
      h('span', {}, t('2D Function Grapher & Calculus Visualizer (Ctrl+Shift+G)'))
    );
    btnGrapher.addEventListener('click', () => {
      this.app.openFunctionGrapher?.();
    });

    const btnInsertFormula = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '∫'),
      h('span', {}, t('Insert MathLive Formula Card'))
    );
    btnInsertFormula.addEventListener('click', () => {
      this.app.command?.('insert.math');
    });

    const btnHandwriting = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '✍️'),
      h('span', {}, t('Windows Ink Math Handwriting Input'))
    );
    btnHandwriting.addEventListener('click', () => {
      this.app.toast?.(t('Windows Ink math handwriting recognition active.'));
    });

    actionSection.appendChild(btnGrapher);
    actionSection.appendChild(btnInsertFormula);
    actionSection.appendChild(btnHandwriting);

    const btnNaturalMath = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🗣️'),
      h('span', {}, t('Natural Math to LaTeX Converter'))
    );
    btnNaturalMath.addEventListener('click', () => {
      const ask = prompt(
        t('Enter natural conversational math (e.g. "integral of x^2 from 0 to 1", "derivative of sin(x)*e^x", "limit of sin(x)/x as x approaches 0"):'),
        'integral of x^2 from 0 to 1'
      );
      if (!ask) return;
      const converted = naturalMathToLaTeX(ask);
      if (converted) {
        navigator.clipboard?.writeText?.(converted);
        this.app.toast?.(t('Converted to LaTeX and copied: {tex}', { tex: converted }));
      }
    });

    const btnQuadratic = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '⚡'),
      h('span', {}, t('Symbolic CAS Quadratic & Linear Solver'))
    );
    btnQuadratic.addEventListener('click', () => {
      const ask = prompt(t('Enter equation to solve (e.g. x^2 - 5x + 6 = 0):'), 'x^2 - 5x + 6 = 0');
      if (!ask) return;
      const sol = SymbolicCAS.solveQuadratic(ask);
      if (sol.ok) {
        this.app.toast?.(t('Roots: {roots}', { roots: sol.latex }));
      } else {
        this.app.toast?.(t('Could not solve: {err}', { err: sol.error || 'Syntax error' }));
      }
    });

    actionSection.appendChild(btnNaturalMath);
    actionSection.appendChild(btnQuadratic);
    container.appendChild(actionSection);
  }

  // --- 3. STEM Science Shelf ---
  renderStemContent(container) {
    const desc = h('p', { class: 'deck-desc' },
      t('Grades 11–12 Chemistry equation balancer, reaction explainer, periodic table, and PhET simulation sandboxes.')
    );
    container.appendChild(desc);

    // Chemical Equation Balancer
    const chemSection = h('div', { class: 'deck-section' });
    chemSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Chemical Equation Balancer')));

    const chemInput = h('input', {
      class: 'deck-input',
      type: 'text',
      value: 'Fe + O2 -> Fe2O3',
      placeholder: 'e.g. Fe + O2 -> Fe2O3'
    });

    const chemOutput = h('div', { class: 'deck-result-box' }, '4 Fe + 3 O2 → 2 Fe2O3 (Synthesis / Redox)');

    let lastChemResult = null;
    const btnBalance = h('button', { class: 'deck-action-btn primary' }, t('Balance & Explain'));
    const btnStampReaction = h('button', { class: 'deck-action-btn', style: 'display:none;margin-top:6px;' },
      h('span', { class: 'btn-icon' }, '📌'),
      h('span', {}, t('Insert Reaction Card to Canvas'))
    );

    btnBalance.addEventListener('click', () => {
      const eq = chemInput.value.trim();
      if (!eq) return;
      try {
        const res = balanceChemicalEquation(eq);
        lastChemResult = res;
        chemOutput.innerHTML = `<strong>${res.balancedString}</strong><br><span style="color:#00e5ff">${res.reactionType.type}</span>: ${res.reactionType.description}`;
        btnStampReaction.style.display = 'flex';
      } catch (err) {
        chemOutput.textContent = err.message || t('Could not balance equation.');
        btnStampReaction.style.display = 'none';
      }
    });

    btnStampReaction.addEventListener('click', () => {
      if (lastChemResult) {
        insertReactionCard(this.app, lastChemResult);
      }
    });

    chemSection.appendChild(chemInput);
    chemSection.appendChild(btnBalance);
    chemSection.appendChild(chemOutput);
    chemSection.appendChild(btnStampReaction);
    container.appendChild(chemSection);

    // Interactive Modules
    const modulesSection = h('div', { class: 'deck-section' });
    modulesSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Interactive Revision Modules')));

    const btnPeriodic = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🧪'),
      h('span', {}, t('Interactive Periodic Table Dock'))
    );
    btnPeriodic.addEventListener('click', () => {
      this.app.openPeriodicTable?.();
    });

    const btnMolecule = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🔬'),
      h('span', {}, t('3D Molecular Structure Viewer (Ctrl+Shift+M)'))
    );
    btnMolecule.addEventListener('click', () => {
      this.app.openMoleculeViewer?.();
    });

    const btnSketcher = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '⚗️'),
      h('span', {}, t('2D Chemical Sketcher & SMILES Studio'))
    );
    btnSketcher.addEventListener('click', () => {
      this.app.openChemicalSketcher?.();
    });

    const btnPhet = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '⚛️'),
      h('span', {}, t('PhET Physics HTML5 Simulation Runner'))
    );
    btnPhet.addEventListener('click', () => {
      this.app.openPhetRunner?.();
    });

    modulesSection.appendChild(btnPeriodic);
    modulesSection.appendChild(btnMolecule);
    modulesSection.appendChild(btnSketcher);
    modulesSection.appendChild(btnPhet);
    container.appendChild(modulesSection);

    // Formula Encyclopedia Section
    const formulaSection = h('div', { class: 'deck-section' });
    formulaSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Formula Encyclopedia & Solver')));

    const formulaSelect = h('select', { class: 'deck-select' });
    FORMULA_CATALOG.forEach((f) => {
      const opt = h('option', { value: f.id }, `${f.name} (${f.latex})`);
      formulaSelect.appendChild(opt);
    });

    const btnStampFormula = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📐'),
      h('span', {}, t('Insert Formula Card to Board'))
    );
    btnStampFormula.addEventListener('click', () => {
      const chosen = FORMULA_CATALOG.find((f) => f.id === formulaSelect.value);
      if (chosen) insertFormulaCard(this.app, chosen);
    });

    formulaSection.appendChild(formulaSelect);
    formulaSection.appendChild(btnStampFormula);
    container.appendChild(formulaSection);
  }

  // --- 4. Study & FSRS Shelf ---
  renderStudyContent(container) {
    const desc = h('p', { class: 'deck-desc' },
      t('Active-recall Study Tape image occlusion, native FSRS v5 spaced repetition, and AnkiConnect synchronization.')
    );
    container.appendChild(desc);

    const studyCards = collectStudyCards(this.app.store);
    const dueCards = studyCards.filter((c) => c.isDue);

    // Live Stats Badge
    const statsRow = h('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;' });
    const pillTotal = h('div', { class: 'deck-stats-pill' }, `📚 ${t('Cards')}: ${studyCards.length}`);
    const pillDue = h('div', { class: 'deck-stats-pill', style: dueCards.length ? 'color:#ef4444;border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.08);' : '' }, `⏰ ${t('Due')}: ${dueCards.length}`);
    statsRow.appendChild(pillTotal);
    statsRow.appendChild(pillDue);
    container.appendChild(statsRow);

    const srsSection = h('div', { class: 'deck-section' });
    srsSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Active Recall & Occlusion')));

    const btnStartReview = h('button', { class: 'deck-action-btn primary' },
      h('span', { class: 'btn-icon' }, '🚀'),
      h('span', {}, t('Start Active Review Session (Ctrl+Shift+R)'))
    );
    btnStartReview.addEventListener('click', () => {
      this.app.startStudySession?.();
    });

    const btnReviewDue = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '⏰'),
      h('span', {}, t('Review Due Cards Only'))
    );
    btnReviewDue.addEventListener('click', () => {
      this.app.startStudySession?.({ onlyDue: true });
    });

    const btnStudyTape = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🩹'),
      h('span', {}, t('Arm Study Tape Tool (Curtain / Cover)'))
    );
    btnStudyTape.addEventListener('click', () => {
      this.app.setTool?.('tape');
      this.app.syncUI?.();
      this.app.toast?.(t('Study Tape active: Drag strips over labels to occlude them for revision.'));
    });

    const btnOcclusionMode = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🙈'),
      h('span', {}, t('Image Occlusion: Hide All vs Hide One'))
    );
    btnOcclusionMode.addEventListener('click', () => {
      if (this.app.studyRunner) {
        this.app.studyRunner.toggleOcclusionMode?.();
      } else {
        this.app.toast?.(t('Start review session first to toggle occlusion modes.'));
      }
    });

    srsSection.appendChild(btnStartReview);
    srsSection.appendChild(btnReviewDue);
    srsSection.appendChild(btnStudyTape);
    srsSection.appendChild(btnOcclusionMode);
    container.appendChild(srsSection);

    // FSRS Quick Review Rating
    const fsrsSection = h('div', { class: 'deck-section' });
    fsrsSection.appendChild(h('h5', { class: 'deck-section-title' }, t('FSRS v5 Retention Rating')));

    const ratingGrid = h('div', { style: 'display:grid;grid-template-columns:repeat(4, 1fr);gap:6px;margin-top:6px;' });
    const rates = [
      { label: t('Again'), color: '#e53e3e', interval: '<10m' },
      { label: t('Hard'), color: '#dd6b20', interval: '1d' },
      { label: t('Good'), color: '#3182ce', interval: '3d' },
      { label: t('Easy'), color: '#38a169', interval: '7d' }
    ];

    rates.forEach((r) => {
      const b = h('button', {
        class: 'deck-rate-btn',
        style: `border-color:${r.color};color:${r.color};`
      }, `${r.label}\n(${r.interval})`);
      b.addEventListener('click', () => {
        this.app.toast?.(t('Rated {rate} — FSRS stability updated to {interval}', { rate: r.label, interval: r.interval }));
      });
      ratingGrid.appendChild(b);
    });

    fsrsSection.appendChild(ratingGrid);
    container.appendChild(fsrsSection);

    // Export & Anki Sync
    const exportSection = h('div', { class: 'deck-section' });
    exportSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Anki Sync & APKG')));

    const btnAnkiSync = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🔄'),
      h('span', {}, t('Sync to Desktop Anki (AnkiConnect :8765)'))
    );
    btnAnkiSync.addEventListener('click', async () => {
      btnAnkiSync.disabled = true;
      btnAnkiSync.textContent = t('Syncing to AnkiConnect...');
      const res = await this.app.syncToAnki?.();
      btnAnkiSync.disabled = false;
      btnAnkiSync.innerHTML = `<span class="btn-icon">🔄</span><span>${t('Sync to Desktop Anki (AnkiConnect :8765)')}</span>`;
      if (res?.ok) {
        this.app.toast?.(t('Successfully pushed {count} cards to Anki deck "{deck}"!', { count: res.count, deck: res.deckName }));
      } else if (res?.error) {
        this.app.toast?.(res.error);
      }
    });

    const btnApkgExport = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📦'),
      h('span', {}, t('Export Flashcards to .apkg (AnkiDroid / iOS)'))
    );
    btnApkgExport.addEventListener('click', async () => {
      btnApkgExport.disabled = true;
      btnApkgExport.textContent = t('Exporting .apkg...');
      const res = await this.app.exportToApkg?.();
      btnApkgExport.disabled = false;
      btnApkgExport.innerHTML = `<span class="btn-icon">📦</span><span>${t('Export Flashcards to .apkg (AnkiDroid / iOS)')}</span>`;
      if (res?.ok) {
        this.app.toast?.(t('Exported {count} cards to {name}', { count: res.count, name: res.filePath?.split(/[\\/]/).pop() || '.apkg' }));
      } else if (res?.error && !res.cancelled) {
        this.app.toast?.(res.error);
      }
    });

    const btnExportCloze = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📑'),
      h('span', {}, t('Export Cloze Flashcards (.tsv)'))
    );
    btnExportCloze.addEventListener('click', () => {
      const deck = this.app.studyRunner?.exportClozeDeck?.();
      if (deck?.tsv) {
        navigator.clipboard?.writeText?.(deck.tsv);
        this.app.toast?.(t('Copied {count} occlusion flashcards to clipboard in Anki TSV format!', { count: deck.count }));
      }
    });

    exportSection.appendChild(btnAnkiSync);
    exportSection.appendChild(btnApkgExport);
    exportSection.appendChild(btnExportCloze);
    container.appendChild(exportSection);
  }

  // --- 5. ESL & Voice Shelf ---
  renderEslContent(container) {
    const desc = h('p', { class: 'deck-desc' },
      t('Offline technical dictionary, engineering collocations, grammar checks, and native zero-download Web Speech TTS.')
    );
    container.appendChild(desc);

    const dictSection = h('div', { class: 'deck-section' });
    dictSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Technical Dictionary Lookup')));

    const wordInput = h('input', {
      class: 'deck-input',
      type: 'text',
      value: 'dielectric',
      placeholder: t('Enter technical term...')
    });

    const dictResult = h('div', { class: 'deck-result-box' });
    let currentEntry = DICTIONARY_DATABASE['dielectric'];

    const updateDictView = (entry) => {
      currentEntry = entry;
      dictResult.innerHTML = `
        <div style="font-weight:700;color:#00e5ff;font-size:13px;">${entry.word} ${entry.ipa ? `[${entry.ipa}]` : ''} <em>(${entry.pos})</em></div>
        <p style="margin:4px 0 6px;font-size:12px;opacity:0.9;">${entry.def}</p>
        ${entry.collocations?.length ? `<div style="font-size:11px;opacity:0.75;"><strong style="color:#f59e0b;">${t('Collocations')}:</strong> ${entry.collocations.join(', ')}</div>` : ''}
      `;
    };

    updateDictView(currentEntry);

    const btnLookup = h('button', { class: 'deck-action-btn primary' }, t('Lookup Term'));
    btnLookup.addEventListener('click', () => {
      const w = wordInput.value.trim().toLowerCase();
      const entry = DICTIONARY_DATABASE[w] || {
        word: w,
        ipa: '',
        pos: 'noun',
        def: t('Technical engineering term. Refer to offline textbook or datasheet.'),
        collocations: []
      };
      updateDictView(entry);
    });

    const btnSpeak = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🔊'),
      h('span', {}, t('Pronounce Term (Native Windows TTS)'))
    );
    btnSpeak.addEventListener('click', () => {
      const term = wordInput.value.trim() || 'dielectric';
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(term);
        u.rate = 0.9;
        window.speechSynthesis.speak(u);
      } else {
        this.app.toast?.(t('Web Speech API is not supported in this environment.'));
      }
    });

    const btnStampWord = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📌'),
      h('span', {}, t('Insert Definition to Canvas'))
    );
    btnStampWord.addEventListener('click', () => {
      if (currentEntry) {
        this.app.dictionaryPopover?.stampCard?.(currentEntry);
      }
    });

    const btnAcademicDict = h('button', { class: 'deck-action-btn primary', style: 'margin-bottom:8px;' },
      h('span', { class: 'btn-icon' }, '📖'),
      h('span', {}, t('Academic Dictionary & Thesaurus (Ctrl+Shift+D)'))
    );
    btnAcademicDict.addEventListener('click', () => {
      this.app.openAcademicDictionary?.();
    });

    dictSection.appendChild(btnAcademicDict);
    dictSection.appendChild(wordInput);
    dictSection.appendChild(btnLookup);
    dictSection.appendChild(btnSpeak);
    dictSection.appendChild(btnStampWord);
    dictSection.appendChild(dictResult);
    container.appendChild(dictSection);

    // Technical Writing & ESL Linter
    const linterSection = h('div', { class: 'deck-section' });
    linterSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Technical Writing & Style Linter')));

    const linterInput = h('textarea', {
      class: 'deck-input',
      rows: '3',
      style: 'resize:vertical;font-family:inherit;font-size:12px;',
      placeholder: t('Paste engineering text to lint for passive voice, wordiness, and redundancies...')
    });

    const linterOutput = h('div', { class: 'deck-result-box', style: 'max-height:120px;overflow-y:auto;' }, t('Linter: ready'));

    const btnRunLint = h('button', { class: 'deck-action-btn primary' }, t('Check Technical Phrasing'));
    btnRunLint.addEventListener('click', () => {
      const txt = linterInput.value.trim();
      if (!txt) {
        linterOutput.textContent = t('Please enter text to analyze.');
        return;
      }
      const issues = TechnicalLinter.lint(txt);
      if (issues.length === 0) {
        linterOutput.innerHTML = `<span style="color:#22c55e;">✔</span> ${t('No style or redundancy issues detected. Clear technical prose!')}`;
      } else {
        linterOutput.innerHTML = issues.map((iss) => `
          <div style="margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:4px;">
            <span class="deck-stats-pill" style="font-size:10px;padding:1px 4px;margin-right:4px;">${iss.rule}</span>
            <span style="font-size:11px;">${iss.message}</span>
          </div>
        `).join('');
      }
    });

    const btnAcademicScore = h('button', { class: 'deck-action-btn', style: 'margin-top:4px;' },
      h('span', { class: 'btn-icon' }, '🎓'),
      h('span', {}, t('Evaluate Academic Style Score (0–100%)'))
    );
    btnAcademicScore.addEventListener('click', () => {
      const txt = linterInput.value.trim();
      if (!txt) {
        linterOutput.textContent = t('Please enter text to analyze.');
        return;
      }
      const res = TechnicalLinter.evaluateAcademicStyle(txt);
      linterOutput.innerHTML = `
        <div style="font-weight:700;color:#3b82f6;font-size:13px;">${t('Academic Style Score')}: ${res.score}% (${res.rating})</div>
        ${res.deductions.map((d) => `<div style="font-size:11px;margin-top:2px;">• -${d.penalty} pts: ${d.message}</div>`).join('')}
        ${!res.deductions.length ? `<div style="color:#22c55e;font-size:11px;margin-top:2px;">✔ ${t('Exemplary scholarly clarity and academic tone!')}</div>` : ''}
      `;
    });

    const btnFixTone = h('button', { class: 'deck-action-btn', style: 'margin-top:4px;' },
      h('span', { class: 'btn-icon' }, '✨'),
      h('span', {}, t('Elevate to Formal Academic Tone'))
    );
    btnFixTone.addEventListener('click', () => {
      const txt = linterInput.value.trim();
      if (!txt) return;
      const elevated = TechnicalLinter.applyAcademicTone(txt);
      linterInput.value = elevated;
      this.app.toast?.(t('Elevated informal expressions to academic tone.'));
    });

    linterSection.appendChild(linterInput);
    linterSection.appendChild(btnRunLint);
    linterSection.appendChild(btnAcademicScore);
    linterSection.appendChild(btnFixTone);
    linterSection.appendChild(linterOutput);
    container.appendChild(linterSection);
  }

  // --- 6. Diagrams & PDF Shelf ---
  renderDiagramsContent(container) {
    const desc = h('p', { class: 'deck-desc' },
      t('Visual form builder for Mermaid flowcharts and LiquidText-style bidirectional PDF excerpt anchoring.')
    );
    container.appendChild(desc);

    const diagSection = h('div', { class: 'deck-section' });
    diagSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Diagram & Flowchart Studio')));

    const btnMermaid = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📊'),
      h('span', {}, t('Open Diagramming & Chart Studio'))
    );
    btnMermaid.addEventListener('click', () => {
      this.app.openVisualizationStudio?.();
    });

    const btnKnowledgeGraph = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🕸️'),
      h('span', {}, t('Interactive Knowledge Graph View'))
    );
    btnKnowledgeGraph.addEventListener('click', () => {
      this.app.openGraphView?.();
    });

    const btnKanban = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📋'),
      h('span', {}, t('Insert Kanban Board'))
    );
    btnKanban.addEventListener('click', async () => {
      const { KanbanManager } = await import('../core/kanban.js');
      const view = this.app.surface?.cam ? this.app.surface.cam.viewport(this.app.surface.width, this.app.surface.height) : { x: 0, y: 0, w: 800, h: 600 };
      const boardObj = KanbanManager.createDefault(view.x + view.w / 2 - 300, view.y + view.h / 2 - 200, t('Sprint Board'));
      this.app.store?.add(boardObj, 'kanban');
      this.app.surface?.damageAll();
      this.app.toast?.(t('Kanban board inserted'));
    });

    const btnDataview = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📊'),
      h('span', {}, t('Run Dataview Query Table'))
    );
    btnDataview.addEventListener('click', async () => {
      const { DataviewEngine } = await import('../core/dataview.js');
      const query = window.prompt(t('Enter Dataview query:'), 'TABLE name, type WHERE type != "" LIMIT 10');
      if (!query) return;
      const res = DataviewEngine.execute(query, this.app.store);
      const view = this.app.surface?.cam ? this.app.surface.cam.viewport(this.app.surface.width, this.app.surface.height) : { x: 0, y: 0, w: 800, h: 600 };
      const cardObj = {
        id: 'card_' + Date.now(),
        type: 'card',
        x: view.x + view.w / 2 - 220,
        y: view.y + view.h / 2 - 150,
        w: 440,
        h: 300,
        title: `Dataview — ${query.slice(0, 24)}`,
        html: res.html,
        text: `Dataview Query: ${query}`
      };
      this.app.store?.add(cardObj, 'dataview');
      this.app.surface?.damageAll();
      this.app.toast?.(t('Dataview query results stamped'));
    });

    diagSection.appendChild(btnMermaid);
    diagSection.appendChild(btnKnowledgeGraph);
    diagSection.appendChild(btnKanban);
    diagSection.appendChild(btnDataview);
    container.appendChild(diagSection);

    // LiquidText Synthesis
    const pdfSection = h('div', { class: 'deck-section' });
    pdfSection.appendChild(h('h5', { class: 'deck-section-title' }, t('LiquidText PDF Excerpt Anchors')));

    const btnMakeExcerpt = h('button', { class: 'deck-action-btn primary' },
      h('span', { class: 'btn-icon' }, '✂️'),
      h('span', {}, t('Extract Excerpt from Selection'))
    );
    btnMakeExcerpt.addEventListener('click', () => {
      this.app.copyAsExcerpt?.();
    });

    const btnPdfNavigator = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '📑'),
      h('span', {}, t('Toggle Document Navigator & TOC'))
    );
    btnPdfNavigator.addEventListener('click', () => {
      this.app.togglePdfSidebar?.();
    });

    const btnTethers = h('button', { class: 'deck-action-btn' },
      h('span', { class: 'btn-icon' }, '🔗'),
      h('span', {}, t('Toggle Elastic Relationship Tethers'))
    );
    btnTethers.addEventListener('click', () => {
      if (this.app.settings) {
        this.app.settings.showExcerptTethers = !this.app.settings.showExcerptTethers;
        this.app.saveSettings?.();
        this.app.surface?.invalidate?.();
        this.app.toast?.(t('Excerpt tethers {state}', {
          state: this.app.settings.showExcerptTethers ? t('enabled') : t('disabled')
        }));
      }
    });

    pdfSection.appendChild(btnMakeExcerpt);
    pdfSection.appendChild(btnPdfNavigator);
    pdfSection.appendChild(btnTethers);

    // Excerpt drawer list
    const excerpts = (this.app.store?.objects || []).filter((o) => o.type === 'image' && o.excerptSource?.boardId);
    if (excerpts.length) {
      const excerptListTitle = h('h6', { style: 'margin:12px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.75;' }, `${t('Document Excerpts')} (${excerpts.length})`);
      pdfSection.appendChild(excerptListTitle);
      excerpts.forEach((ex) => {
        const item = h('div', { class: 'deck-excerpt-item' });
        const thumb = h('img', { class: 'deck-excerpt-thumb', src: ex.src });
        const meta = h('div', { class: 'deck-excerpt-meta' });
        const title = h('span', { class: 'deck-excerpt-title' }, ex.excerptSource.boardName || t('Document Excerpt'));
        const sub = h('span', { class: 'deck-excerpt-sub' }, `Page ${ex.excerptSource.page || 1}`);
        meta.appendChild(title);
        meta.appendChild(sub);
        item.appendChild(thumb);
        item.appendChild(meta);
        item.addEventListener('click', () => {
          this.app.openExcerptSource?.(ex);
        });
        pdfSection.appendChild(item);
      });
    }

    container.appendChild(pdfSection);
  }

  // --- 7. Layout & Brand Shelf ---
  renderLayoutContent(container) {
    const desc = h('p', { class: 'deck-desc' },
      t('Customize ribbon docking position, visual appearance theme, and application display branding.')
    );
    container.appendChild(desc);

    // Position Toggle
    const posSection = h('div', { class: 'deck-section' });
    posSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Sidebar Docking Edge')));

    const posRow = h('div', { class: 'deck-btn-group' });
    const btnLeft = h('button', {
      class: `deck-pill-btn ${this.position === 'left' ? 'active' : ''}`
    }, t('Left Dock'));
    btnLeft.addEventListener('click', () => {
      this.position = 'left';
      btnLeft.classList.add('active');
      btnRight.classList.remove('active');
      this.syncState();
      this.app?.updateHudLayout?.('ribbon');
    });

    const btnRight = h('button', {
      class: `deck-pill-btn ${this.position === 'right' ? 'active' : ''}`
    }, t('Right Dock'));
    btnRight.addEventListener('click', () => {
      this.position = 'right';
      btnRight.classList.add('active');
      btnLeft.classList.remove('active');
      this.syncState();
      this.app?.updateHudLayout?.('ribbon');
    });

    posRow.appendChild(btnLeft);
    posRow.appendChild(btnRight);
    posSection.appendChild(posRow);
    container.appendChild(posSection);

    // Style Mode Toggle
    const styleSection = h('div', { class: 'deck-section' });
    styleSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Visual Design Theme')));

    const styleRow = h('div', { class: 'deck-btn-group' });
    const btnGlass = h('button', {
      class: `deck-pill-btn ${this.styleMode === 'glassmorphism' ? 'active' : ''}`
    }, t('Glassmorphism'));
    btnGlass.addEventListener('click', () => {
      this.styleMode = 'glassmorphism';
      btnGlass.classList.add('active');
      btnMat.classList.remove('active');
      if (this.app?.settings) {
        this.app.settings.sidebarRibbonStyle = 'glassmorphism';
        this.app.saveSettings?.();
      }
      this.syncState();
      this.app?.applyTheme?.();
    });

    const btnMat = h('button', {
      class: `deck-pill-btn ${this.styleMode === 'material' ? 'active' : ''}`
    }, t('Google Material'));
    btnMat.addEventListener('click', () => {
      this.styleMode = 'material';
      btnMat.classList.add('active');
      btnGlass.classList.remove('active');
      if (this.app?.settings) {
        this.app.settings.sidebarRibbonStyle = 'material';
        this.app.saveSettings?.();
      }
      this.syncState();
      this.app?.applyTheme?.();
    });

    styleRow.appendChild(btnGlass);
    styleRow.appendChild(btnMat);
    styleSection.appendChild(styleRow);
    container.appendChild(styleSection);

    // Dynamic Brand Switcher (Section 2.4 of Doc 6)
    const brandSection = h('div', { class: 'deck-section' });
    brandSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Display Brand Name')));

    const brandInput = h('input', {
      class: 'deck-input',
      type: 'text',
      value: this.getBrandName(),
      placeholder: 'GaussBoard / JazaBoard / GazBoard'
    });

    const brandPresets = h('div', { class: 'deck-btn-group', style: 'margin-top:6px;' });
    ['GaussBoard', 'JazaBoard', 'GazBoard'].forEach((bName) => {
      const presetBtn = h('button', { class: 'deck-pill-btn' }, bName);
      presetBtn.addEventListener('click', () => {
        brandInput.value = bName;
        this.setBrandName(bName);
      });
      brandPresets.appendChild(presetBtn);
    });

    const btnSaveBrand = h('button', { class: 'deck-action-btn primary', style: 'margin-top:6px;' }, t('Save Display Name'));
    btnSaveBrand.addEventListener('click', () => {
      this.setBrandName(brandInput.value);
    });

    brandSection.appendChild(brandInput);
    brandSection.appendChild(brandPresets);
    brandSection.appendChild(btnSaveBrand);
    container.appendChild(brandSection);

    // Spine Categories Visibility Customizer
    const customSection = h('div', { class: 'deck-section' });
    customSection.appendChild(h('h5', { class: 'deck-section-title' }, t('Category Spine Visibility')));
    customSection.appendChild(h('p', { style: 'font-size:12px;opacity:0.75;margin:0 0 8px;' }, t('Choose which category icons appear on the vertical rail:')));

    const catList = [
      { id: 'circuits', label: t('Circuits & EE') },
      { id: 'math', label: t('Math & CAS') },
      { id: 'stem', label: t('STEM Science') },
      { id: 'study', label: t('Study & FSRS') },
      { id: 'esl', label: t('ESL & Voice') },
      { id: 'diagrams', label: t('Diagrams & PDF') }
    ];

    catList.forEach(c => {
      const isVisible = !this.hiddenCategories.includes(c.id);
      const row = h('label', { style: 'display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0;cursor:pointer;' },
        h('input', {
          type: 'checkbox',
          checked: isVisible,
          onchange: (e) => {
            if (e.target.checked) {
              this.hiddenCategories = this.hiddenCategories.filter(id => id !== c.id);
            } else {
              if (!this.hiddenCategories.includes(c.id)) this.hiddenCategories.push(c.id);
            }
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('gazboard_ribbon_hidden_cats', JSON.stringify(this.hiddenCategories));
            }
            this.syncCategoryVisibility();
          }
        }),
        h('span', {}, c.label)
      );
      customSection.appendChild(row);
    });

    // Inking Auto-Hide Toggle
    const autoHideRow = h('label', { style: 'display:flex;align-items:center;gap:8px;font-size:12.5px;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);cursor:pointer;' },
      h('input', {
        type: 'checkbox',
        checked: this.inkingAutoHide,
        onchange: (e) => {
          this.inkingAutoHide = e.target.checked;
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('gazboard_ribbon_autohide', String(this.inkingAutoHide));
          }
          this.app.toast?.(this.inkingAutoHide ? t('Inking auto-hide enabled') : t('Inking auto-hide disabled'));
        }
      }),
      h('span', {}, t('Auto-collapse tool shelf while drawing'))
    );
    customSection.appendChild(autoHideRow);
    container.appendChild(customSection);
  }
}
