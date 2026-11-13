import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VIDEO_CAMERA_MODES, VIDEO_FIXED_FRAMES,
  boundsForObjects, boundsForTrack, targetCameraForBox,
  strokeAtOrAfter, followExportCamera, VideoExporter
} from '../src/js/export-video.js';

test('video framing distinguishes recording bounds from whole-board bounds', () => {
  const objects = {
    inkA: { type: 'stroke', audioId: 'track-a', bbox: { x: 20, y: 30, w: 40, h: 20 }, t0: 0, t1: 1000 },
    inkB: { type: 'stroke', audioId: 'track-b', bbox: { x: 500, y: 400, w: 60, h: 30 }, t0: 0, t1: 1000 },
    note: { type: 'note', x: -100, y: -80, w: 50, h: 40 }
  };
  assert.deepEqual(boundsForTrack(objects, 'track-a'), { x: 20, y: 30, w: 40, h: 20 });
  assert.deepEqual(boundsForObjects(objects, [{ w: 600, h: 800 }]), { x: -300, y: -400, w: 860, h: 830 });
  assert.equal(VIDEO_CAMERA_MODES.FIXED, 'fixed');
  assert.equal(VIDEO_CAMERA_MODES.FOLLOW, 'follow');
  assert.equal(VIDEO_FIXED_FRAMES.RECORDING, 'recording');
  assert.equal(VIDEO_FIXED_FRAMES.BOARD, 'board');
});

test('follow framing chooses the active or next stroke and eases the export camera toward it', () => {
  const active = { id: 'active', type: 'stroke', audioId: 'track-a', bbox: { x: 20, y: 30, w: 40, h: 20 }, t0: 0, t1: 1000 };
  const next = { id: 'later', type: 'stroke', audioId: 'track-a', bbox: { x: 700, y: 50, w: 20, h: 20 }, t0: 1200, t1: 1600 };
  const objects = { active, otherTrack: { ...next, id: 'other', audioId: 'track-b' }, next };
  assert.equal(strokeAtOrAfter(objects, 'track-a', 500), active);
  assert.equal(strokeAtOrAfter(objects, 'track-a', 1000), next);

  const target = targetCameraForBox(next.bbox, 1280, 720);
  assert.ok(target && Object.values(target).every(Number.isFinite));
  const surface = { cam: { x: 0, y: 0, z: 1 } };
  followExportCamera(surface, next, 1280, 720, 33);
  assert.ok(surface.cam.x < 0, 'camera moves rightward toward the later stroke');
  assert.ok(surface.cam.z > 1, 'camera zooms to frame the stroke');
});

test('single-recording export forwards its selected camera framing into the replay exporter', async () => {
  const exporter = new VideoExporter({});
  exporter.exportReplayVideo = async (options) => options;
  const result = await exporter.exportStitchedReplayVideo({
    tracks: [{ id: 'one-track', assetId: 'asset-1' }], width: 1280, height: 720, fps: 30,
    cameraMode: VIDEO_CAMERA_MODES.FOLLOW, fixedFrame: VIDEO_FIXED_FRAMES.BOARD
  });
  assert.equal(result.cameraMode, VIDEO_CAMERA_MODES.FOLLOW);
  assert.equal(result.fixedFrame, VIDEO_FIXED_FRAMES.BOARD);
});
