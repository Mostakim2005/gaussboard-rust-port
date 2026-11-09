import test from 'node:test';
import assert from 'node:assert/strict';
import { HardwareAudioClock } from '../src/js/core/audio-clock.js';

test('HardwareAudioClock computes monotonic millisecond timestamps without AudioContext', () => {
  const clock = new HardwareAudioClock(null);
  const t0 = clock.nowMs();
  assert.equal(typeof t0, 'number');
  assert.ok(t0 >= 0);

  clock.pause();
  const pausedVal = clock.nowMs();
  assert.equal(typeof pausedVal, 'number');

  clock.resume();
  const t1 = clock.nowMs();
  assert.ok(t1 >= pausedVal);
});

test('HardwareAudioClock utilizes AudioContext getOutputTimestamp when available', () => {
  let perfTime = 5000;
  const mockCtx = {
    currentTime: 10.5,
    getOutputTimestamp: () => ({
      contextTime: 10.5,
      performanceTime: perfTime
    })
  };

  const clock = new HardwareAudioClock(mockCtx);
  clock.startContextTime = 10.0; // 0.5s elapsed = 500ms
  perfTime = performance.now(); // delta = 0
  const ms = clock.nowMs();
  assert.ok(ms >= 490 && ms <= 510, `Expected ~500ms, got ${ms}`);
});
