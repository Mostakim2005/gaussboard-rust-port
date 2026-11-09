// audio-clock.js — Hardware-locked audio sample clock for TRAP 2 (Timestamp Preservation)
// Synchronizes stroke point p.t directly to soundcard ADC timestamps.

export class HardwareAudioClock {
  /**
   * @param {AudioContext} audioContext
   */
  constructor(audioContext) {
    this.ctx = audioContext;
    this.accumulatedPauseMs = 0;
    this.pauseStartMono = null;
    this.startContextTime = audioContext ? audioContext.currentTime : 0;
    this.fallbackStartMono = performance.now();
    this.lastActiveAudioMs = 0;
  }

  /**
   * Called on every pointermove / coalesced stylus event in InkEngine.
   * Returns exact integer milliseconds locked to the hardware audio ADC clock.
   * @returns {number}
   */
  nowMs() {
    if (this.pauseStartMono !== null) {
      return Math.round(this.lastActiveAudioMs);
    }

    if (!this.ctx) {
      const elapsed = performance.now() - this.fallbackStartMono - this.accumulatedPauseMs;
      this.lastActiveAudioMs = Math.max(0, elapsed);
      return Math.round(this.lastActiveAudioMs);
    }

    // Query synchronized pair of (contextTime in seconds, performance.now() in ms)
    if (typeof this.ctx.getOutputTimestamp === 'function') {
      const ts = this.ctx.getOutputTimestamp();
      if (ts && ts.performanceTime && ts.performanceTime > 0) {
        const deltaSinceAudioBlockMs = performance.now() - ts.performanceTime;
        const exactAudioElapsedMs =
          (ts.contextTime - this.startContextTime) * 1000 + deltaSinceAudioBlockMs;
        this.lastActiveAudioMs = Math.max(0, exactAudioElapsedMs - this.accumulatedPauseMs);
        return Math.round(this.lastActiveAudioMs);
      }
    }

    const elapsedFromCtx = (this.ctx.currentTime - this.startContextTime) * 1000;
    this.lastActiveAudioMs = Math.max(0, elapsedFromCtx - this.accumulatedPauseMs);
    return Math.round(this.lastActiveAudioMs);
  }

  pause() {
    if (this.pauseStartMono === null) {
      this.nowMs();
      this.pauseStartMono = performance.now();
    }
  }

  resume() {
    if (this.pauseStartMono !== null) {
      this.accumulatedPauseMs += performance.now() - this.pauseStartMono;
      this.pauseStartMono = null;
    }
  }

  reset() {
    this.accumulatedPauseMs = 0;
    this.pauseStartMono = null;
    this.startContextTime = this.ctx ? this.ctx.currentTime : 0;
    this.fallbackStartMono = performance.now();
    this.lastActiveAudioMs = 0;
  }
}
