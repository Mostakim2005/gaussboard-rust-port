import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawTimedBezierAtClock,
  jumpToAudioInkHit,
  onStrokeAltClickSeekAudio
} from '../src/js/core/replay.js';

test('drawTimedBezierAtClock evaluates sub-segment via De Casteljau subdivision', () => {
  const seg = {
    p0: [0, 0],
    p1: [10, 20],
    p2: [30, 20],
    p3: [40, 0],
    t_start: 1000,
    t_end: 2000
  };

  const drawCalls = [];
  const mockCtx = {
    bezierCurveTo: (c1x, c1y, c2x, c2y, ex, ey) => {
      drawCalls.push({ c1x, c1y, c2x, c2y, ex, ey });
    }
  };

  // 1. Before t_start: no drawing
  drawTimedBezierAtClock(mockCtx, seg, 500);
  assert.equal(drawCalls.length, 0);

  // 2. Midpoint (u = 0.5 at 1500ms): evaluates left sub-segment
  drawTimedBezierAtClock(mockCtx, seg, 1500);
  assert.equal(drawCalls.length, 1);
  const midCall = drawCalls[0];
  assert.ok(midCall.ex < 40, 'End x should be less than final curve end point');

  // 3. At or after t_end (2500ms): draws full curve
  drawTimedBezierAtClock(mockCtx, seg, 2500);
  assert.equal(drawCalls.length, 2);
  const endCall = drawCalls[1];
  assert.equal(endCall.ex, 40);
  assert.equal(endCall.ey, 0);
});

test('jumpToAudioInkHit synchronizes camera and audio clock', () => {
  let sought = null;
  const mockReplay = {
    seekToMs: (sid, ms) => { sought = { sid, ms }; }
  };
  let animatedCamera = null;
  let flashedStroke = null;
  const mockSurface = {
    width: 1000,
    height: 800,
    animateCameraTo: (cx, cy, zoom, dur) => { animatedCamera = { cx, cy, zoom, dur }; },
    flashStrokeHighlight: (id, dur) => { flashedStroke = { id, dur }; }
  };

  const hit = {
    session_id: 'sess_1',
    audio_seek_ms: 14500,
    camera_center_x: 250,
    camera_center_y: 350,
    bbox_width: 80,
    bbox_height: 40,
    stroke_id: 'strk_99'
  };

  jumpToAudioInkHit(mockSurface, mockReplay, hit);
  assert.deepEqual(sought, { sid: 'sess_1', ms: 14500 });
  assert.equal(animatedCamera.cx, 250);
  assert.equal(animatedCamera.cy, 350);
  assert.equal(flashedStroke.id, 'strk_99');
});

test('onStrokeAltClickSeekAudio seeks replay to stroke start timestamp', () => {
  let sought = null;
  const mockReplay = {
    seekToMs: (sid, ms) => { sought = { sid, ms }; }
  };

  const stroke = {
    sessionId: 'session_abc',
    points: [{ x: 10, y: 20, t: 3200 }, { x: 15, y: 25, t: 3400 }]
  };

  onStrokeAltClickSeekAudio(stroke, mockReplay);
  assert.deepEqual(sought, { sid: 'session_abc', ms: 3200 });
});
