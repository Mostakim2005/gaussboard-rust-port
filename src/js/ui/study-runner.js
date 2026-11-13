/**
 * GazBoard - In-App Spaced Repetition (FSRS v5) Review Runner
 * Runs interactive active-recall flashcard review sessions over Study Tape and Answer Covers.
 * Features smooth camera gliding, occlusion toggling, and real-time retention rating.
 */

import { t } from '../i18n.js';
import { boundsOf } from '../core/store.js';
import { Rating, collectStudyCards, repeat, previewNextIntervals } from '../core/fsrs.js';

export class StudyRunner {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.cards = [];
    this.currentIndex = 0;
    this.revealed = false;
    this.container = null;
    this.stats = { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };
    this.occlusionMode = 'hideAll'; // 'hideAll' (Hide All, Guess One) | 'hideOne' (Hide One, Guess One)
    this._onKeyDown = this.handleKeyDown.bind(this);
  }

  /**
   * Set a cover's review-time visibility.
   *
   * A review is a view state, not an edit, so it is not a store transaction -
   * but it still has to keep the object graph coherent: content written ON the
   * card follows the card (see App.setCovers), and the canvas must be told the
   * picture changed (see refreshCanvas), or the frozen scene is blitted back
   * unchanged and the answer never appears.
   */
  setReviewState(card, revealed) {
    const o = card?.object;
    if (!o) return;
    o.revealed = revealed;
    for (const w of this.app.onCovers?.([o.id]) || []) {
      if (!w.hiddenManual) w.hidden = revealed;
    }
  }

  /** In-place state changed: move the frozen-scene key, then repaint. */
  refreshCanvas() {
    const sf = this.app.surface;
    if (!sf) return;
    sf.touch?.();
    sf.invalidate?.();
  }

  /** Start a review session */
  start({ onlyDue = false } = {}) {
    if (this.active) this.stop();

    const allCards = collectStudyCards(this.app.store);
    if (!allCards.length) {
      this.app.toast?.(t('No Study Tape or Answer Covers found. Use the Study Tape tool (🩹) to occlude items first.'));
      return false;
    }

    // Filter due cards if requested, else prioritize due cards
    let sessionCards = onlyDue ? allCards.filter((c) => c.isDue) : allCards;
    if (onlyDue && !sessionCards.length) {
      this.app.toast?.(t('All Study Tape cards are currently up-to-date! Starting revision of all cards.'));
      sessionCards = allCards;
    }

    // Sort: due cards first, then by last review
    sessionCards.sort((a, b) => {
      if (a.isDue && !b.isDue) return -1;
      if (!a.isDue && b.isDue) return 1;
      return (a.card.due || 0) - (b.card.due || 0);
    });

    this.cards = sessionCards;
    this.currentIndex = 0;
    this.active = true;
    this.stats = { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };

    this.mountUI();
    this.loadCard(this.currentIndex);
    window.addEventListener('keydown', this._onKeyDown, true);
    return true;
  }

  /** Stop and clean up review session */
  stop() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this._onKeyDown, true);
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    // Restore all occlusions to concealed state when exiting study session (Invariant #6)
    if (Array.isArray(this.cards)) {
      this.cards.forEach((c) => {
        if (c?.object) {
          this.setReviewState(c, false);
        }
      });
    }
    this.refreshCanvas();
  }

  /** Mount floating review HUD */
  mountUI() {
    if (this.container) this.container.remove();

    const hud = document.createElement('div');
    hud.className = 'fsrs-study-runner';
    hud.innerHTML = `
      <div class="study-hud-inner">
        <div class="study-hud-top">
          <div class="study-hud-badge">
            <span class="hud-pulse"></span>
            <span class="hud-counter">Card 1 / ${this.cards.length}</span>
          </div>
          <div class="study-hud-title">${t('Study Tape Active Recall')}</div>
          <button class="study-hud-mode-toggle btn" style="font-size:10px;padding:2px 6px;margin-left:auto;margin-right:6px;" title="${t('Toggle between Hide All vs Hide One occlusion modes')}">
            ${this.occlusionMode === 'hideAll' ? '🙈 ' + t('Hide All') : '👁️ ' + t('Hide One')}
          </button>
          <button class="study-hud-close" title="${t('Exit Review (Esc)')}">✕</button>
        </div>
        <div class="study-hud-progress"><div class="study-hud-bar" style="width: 0%"></div></div>
        <div class="study-hud-body">
          <div class="study-hud-prompt">${t('Test your memory: What is hidden under this occlusion?')}</div>
          <div class="study-hud-actions">
            <!-- Dynamic Buttons injected here -->
          </div>
        </div>
      </div>
    `;

    hud.querySelector('.study-hud-mode-toggle').addEventListener('click', () => this.toggleOcclusionMode());
    hud.querySelector('.study-hud-close').addEventListener('click', () => this.stop());
    document.body.appendChild(hud);
    this.container = hud;
  }

  /** Toggle Image Occlusion mode between 'hideAll' (Hide All, Guess One) and 'hideOne' (Hide One, Guess One) */
  toggleOcclusionMode() {
    this.occlusionMode = this.occlusionMode === 'hideAll' ? 'hideOne' : 'hideAll';
    const btn = this.container?.querySelector('.study-hud-mode-toggle');
    if (btn) {
      btn.textContent = this.occlusionMode === 'hideAll' ? '🙈 ' + t('Hide All') : '👁️ ' + t('Hide One');
    }
    const modeLabel = this.occlusionMode === 'hideAll' ? t('Hide All, Guess One') : t('Hide One, Guess One');
    this.app.toast?.(t('Occlusion Mode: {mode}', { mode: modeLabel }));
    this.applyOcclusionVisibility();
    this.refreshCanvas();
  }

  /** Apply occlusion visibility according to active mode */
  applyOcclusionVisibility() {
    const currentItem = this.cards[this.currentIndex];
    if (!currentItem) return;

    if (this.occlusionMode === 'hideAll') {
      // In Hide All: all cards remain concealed; only current card becomes revealed when answer is shown
      this.cards.forEach((c) => {
        if (c === currentItem) {
          this.setReviewState(c, this.revealed);
        } else {
          this.setReviewState(c, false);
        }
      });
    } else {
      // In Hide One: all other cards are revealed to show surrounding context, ONLY current card is concealed
      this.cards.forEach((c) => {
        if (c === currentItem) {
          this.setReviewState(c, this.revealed);
        } else {
          this.setReviewState(c, true);
        }
      });
    }
  }

  /** Load and focus the specified card */
  loadCard(index) {
    if (index >= this.cards.length) {
      this.finishSession();
      return;
    }

    this.currentIndex = index;
    const item = this.cards[index];
    this.revealed = false;

    // Apply concealment according to occlusion mode
    this.applyOcclusionVisibility();
    this.refreshCanvas();

    // Update progress
    const pct = Math.round(((index) / this.cards.length) * 100);
    const counter = this.container?.querySelector('.hud-counter');
    const bar = this.container?.querySelector('.study-hud-bar');
    if (counter) counter.textContent = `${t('Card')} ${index + 1} / ${this.cards.length}`;
    if (bar?.style) bar.style.width = `${pct}%`;

    // Smoothly glide camera to card
    const box = boundsOf(item.object);
    if (box && box.w > 0 && box.h > 0 && this.app.surface?.cam?.glideTo) {
      const vw = this.app.surface?.width || 1000;
      const vh = this.app.surface?.height || 700;
      this.app.surface.cam.glideTo(box, vw, vh, {
        pad: 140,
        duration: 380,
        onStep: () => this.app.surface?.invalidate?.()
      });
    }

    this.renderActions();
  }

  /** Render HUD action buttons based on revealed state */
  renderActions() {
    const actions = this.container?.querySelector('.study-hud-actions');
    if (!actions) return;
    actions.innerHTML = '';

    const currentItem = this.cards[this.currentIndex];
    if (!this.revealed) {
      const btnReveal = document.createElement('button');
      btnReveal.className = 'study-hud-btn reveal-btn';
      btnReveal.innerHTML = `<span class="btn-icon">👁️</span><span>${t('Reveal Answer')}</span><kbd>Space</kbd>`;
      btnReveal.addEventListener('click', () => this.revealAnswer());
      actions.appendChild(btnReveal);
    } else {
      // Show FSRS 4 rating buttons with live intervals
      const intervals = previewNextIntervals(currentItem.card);
      const rates = [
        { rating: Rating.Again, label: t('Again'), interval: intervals.again, color: '#ef4444', key: '1' },
        { rating: Rating.Hard, label: t('Hard'), interval: intervals.hard, color: '#f97316', key: '2' },
        { rating: Rating.Good, label: t('Good'), interval: intervals.good, color: '#3b82f6', key: '3' },
        { rating: Rating.Easy, label: t('Easy'), interval: intervals.easy, color: '#10b981', key: '4' }
      ];

      rates.forEach((r) => {
        const btn = document.createElement('button');
        btn.className = 'study-hud-btn rate-btn';
        btn.style.setProperty('--rate-color', r.color);
        btn.innerHTML = `
          <span class="rate-label">${r.label}</span>
          <span class="rate-interval">${r.interval}</span>
          <kbd>${r.key}</kbd>
        `;
        btn.addEventListener('click', () => this.rateCard(r.rating));
        actions.appendChild(btn);
      });
    }
  }

  /** Reveal the hidden card answer */
  revealAnswer() {
    if (this.revealed || !this.active) return;
    this.revealed = true;
    const currentItem = this.cards[this.currentIndex];
    this.setReviewState(currentItem, true);
    this.applyOcclusionVisibility();
    this.refreshCanvas();
    this.renderActions();
  }

  /**
   * Export all board occlusions as an Anki-compatible TSV cloze file
   * @returns {{ count: number, tsv: string }}
   */
  exportClozeDeck() {
    const allCards = collectStudyCards(this.app.store);
    if (!allCards.length) {
      this.app.toast?.(t('No occlusions found to export.'));
      return { count: 0, tsv: '' };
    }
    const lines = ['#separator:tab', '#html:true', '#tags column:3'];
    allCards.forEach((c, idx) => {
      const q = `GazBoard Occlusion #${idx + 1} (${c.object.subtype || 'tape'})`;
      const a = c.object.text || c.object.note || `Occlusion #${idx + 1} [Revealed]`;
      const tags = 'gazboard image_occlusion fsrs';
      lines.push(`${q}\t${a}\t${tags}`);
    });
    const tsv = lines.join('\n');
    return { count: allCards.length, tsv };
  }

  /** Rate card retention and advance */
  rateCard(rating) {
    if (!this.active || !this.revealed) return;
    const item = this.cards[this.currentIndex];

    // Compute next FSRS state
    const newCard = repeat(item.card, rating);
    item.card = newCard;

    // Track stats
    this.stats.reviewed += 1;
    if (rating === Rating.Again) this.stats.again += 1;
    else if (rating === Rating.Hard) this.stats.hard += 1;
    else if (rating === Rating.Good) this.stats.good += 1;
    else if (rating === Rating.Easy) this.stats.easy += 1;

    // Persist to document store. The patch is applied BY the store; writing
    // `item.object.fsrs` first would make the store record the new value as
    // its own "before" state, so undo could never put the old schedule back.
    this.app.store?.update?.(item.object.id, { fsrs: newCard }, 'rate card fsrs');

    if (this.app.settings?.enableStudySrsProtocol !== false) {
      const dueMs = newCard.due instanceof Date ? newCard.due.getTime() : (Number(newCard.due) || Date.now());
      const intervalDays = Math.max(0, (dueMs - Date.now()) / 86400000);
      const prompt = item.object.text || item.object.note || `Occlusion (${item.object.subtype || 'tape'})`;
      window.board?.search?.scheduleSrsCard?.(
        item.object.id,
        this.app.store?.doc?.id || '',
        String(prompt).slice(0, 240),
        intervalDays,
        Number(newCard.stability) || 0,
        Number(newCard.difficulty) || 0
      )?.catch?.(() => {});
    }

    // Advance to next card
    this.loadCard(this.currentIndex + 1);
  }

  /** Handle keyboard navigation */
  handleKeyDown(e) {
    if (!this.active) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.stop();
      return;
    }

    if (!this.revealed) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.revealAnswer();
      }
    } else {
      if (e.key === '1') {
        e.preventDefault();
        e.stopPropagation();
        this.rateCard(Rating.Again);
      } else if (e.key === '2') {
        e.preventDefault();
        e.stopPropagation();
        this.rateCard(Rating.Hard);
      } else if (e.key === '3') {
        e.preventDefault();
        e.stopPropagation();
        this.rateCard(Rating.Good);
      } else if (e.key === '4') {
        e.preventDefault();
        e.stopPropagation();
        this.rateCard(Rating.Easy);
      }
    }
  }

  /** Show session complete summary */
  finishSession() {
    if (!this.container) return;
    const bar = this.container.querySelector('.study-hud-bar');
    if (bar) bar.style.width = '100%';

    const actions = this.container.querySelector('.study-hud-actions');
    const prompt = this.container.querySelector('.study-hud-prompt');
    const counter = this.container.querySelector('.hud-counter');

    if (counter) counter.textContent = t('Session Complete');
    const retentionPct = this.stats.reviewed > 0 ? Math.round(((this.stats.good + this.stats.easy) / this.stats.reviewed) * 100) : 100;
    if (prompt) {
      prompt.innerHTML = `
        <strong>🎉 ${t('Great work!')}</strong><br>
        ${t('Reviewed {count} cards. Retention accuracy: {pct}%.', { count: this.stats.reviewed, pct: retentionPct })}<br>
        <span style="font-size:11px;color:#94a3b8;">Again: ${this.stats.again} &bull; Hard: ${this.stats.hard} &bull; Good: ${this.stats.good} &bull; Easy: ${this.stats.easy}</span>
      `;
    }

    if (actions) {
      actions.innerHTML = `
        <button class="study-hud-btn btn-stamp-scorecard" style="min-width: 130px;">📸 ${t('Stamp Scorecard')}</button>
        <button class="study-hud-btn primary btn-finish" style="min-width: 130px;">${t('Finish & Return')}</button>
      `;
      actions.querySelector('.btn-stamp-scorecard')?.addEventListener('click', () => this.stampScorecard());
      actions.querySelector('.btn-finish')?.addEventListener('click', () => this.stop());
    }
  }

  stampScorecard() {
    const view = this.app.surface?.cam?.viewport ? this.app.surface.cam.viewport(this.app.surface.width, this.app.surface.height) : { x: 200, y: 200, w: 800, h: 600 };
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;

    const retentionPct = this.stats.reviewed > 0 ? Math.round(((this.stats.good + this.stats.easy) / this.stats.reviewed) * 100) : 100;
    const dateStr = new Date().toLocaleDateString();

    const cardText = `🧠 **${t('Active Recall Review Scorecard')}** — ${dateStr}\n\n` +
      `• **${t('Total Cards Reviewed')}**: ${this.stats.reviewed}\n` +
      `• **${t('Retention Accuracy')}**: ${retentionPct}%\n` +
      `• **${t('FSRS Breakdown')}**: Again: ${this.stats.again} | Hard: ${this.stats.hard} | Good: ${this.stats.good} | Easy: ${this.stats.easy}\n\n` +
      `_Algorithm: Pure JavaScript FSRS v5 (Free Spaced Repetition Scheduler)_`;

    const note = {
      id: `scorecard_${Date.now()}`,
      type: 'text',
      x: cx - 150,
      y: cy - 90,
      w: 300,
      h: 180,
      text: cardText,
      size: 15,
      color: '#10b981'
    };

    this.app.store?.add(note, 'stamp study scorecard');
    this.app.surface?.invalidate?.();
    this.app.toast?.(t('Review scorecard stamped to whiteboard!'));
    this.stop();
  }
}
