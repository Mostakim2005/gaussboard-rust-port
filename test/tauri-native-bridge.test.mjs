import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('tauri-board bridge exposes archive, search, geometry, audioInspect and power APIs with correct IPC calls', async () => {
  const calls = [];
  const mockWindow = {
    addEventListener: () => {},
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          calls.push({ cmd, args });
          if (cmd === 'bundle_export') {
            return { archive_path: args.destZipPath, total_bytes: 1048576, sha256: 'deadbeef' };
          }
          if (cmd === 'bundle_import') {
            return { extracted_dir: args.targetDir, files_count: 12, sha256: 'deadbeef' };
          }
          if (cmd === 'audio_inspect') {
            return { duration_ms: 120500, sample_rate: 48000, channels: 2, codec: 'Opus', is_finite: true };
          }
          if (cmd === 'stroke_simplify_and_fit') {
            return {
              segments: [{ p0: [0, 0], p1: [1, 1], p2: [2, 2], p3: [3, 3], t_start: 100, t_end: 200 }],
              bounds: [0, 0, 3, 3],
              total_arc_length: 4.24,
              original_count: args.points.length,
              simplified_count: 2
            };
          }
          if (cmd === 'search_boards') {
            return [{ board_id: 'board-1', title: 'Calculus Notes', snippet: '<mark>integral</mark>', rank: -1.2 }];
          }
          if (cmd === 'graph_get_backlinks') {
            return [{ source_board_id: 'board-2', source_title: 'Physics II', edge_type: 'wikilink' }];
          }
          if (cmd === 'study_cards_due') {
            return [{ card_id: 'c1', board_id: 'b1', prompt: 'What is Ohm\'s Law?', due_timestamp: 1700000000 }];
          }
          if (cmd === 'get_power_status') {
            return { on_battery: false, battery_percent: 98, power_saver: false };
          }
          return { ok: true };
        }
      },
      event: {
        listen: () => {}
      }
    }
  };

  const code = fs.readFileSync('src/js/platform/tauri-board.js', 'utf-8');
  vm.runInNewContext(code, { window: mockWindow });

  const board = mockWindow.board;
  assert.ok(board, 'window.board must be initialized');

  // 1. Native Streaming Archive API
  assert.ok(board.archive, 'board.archive must exist');
  const exportRes = await board.archive.exportBundle('C:/boards/b1', 'C:/export.gaussboard', true);
  assert.equal(exportRes.sha256, 'deadbeef');
  assert.equal(calls[calls.length - 1].cmd, 'bundle_export');
  assert.equal(calls[calls.length - 1].args.useZstd, true);

  const importRes = await board.archive.importBundle('C:/export.gaussboard', 'C:/boards/imported');
  assert.equal(importRes.files_count, 12);
  assert.equal(calls[calls.length - 1].cmd, 'bundle_import');

  // 2. Pure Rust Audio Duration & Metadata API
  assert.ok(board.audioInspect, 'board.audioInspect must exist');
  const audioRes = await board.audioInspect.inspect('C:/audio/lecture.opus');
  assert.equal(audioRes.duration_ms, 120500);
  assert.equal(audioRes.is_finite, true);
  assert.equal(calls[calls.length - 1].cmd, 'audio_inspect');

  // 3. Stroke Geometry & Curve Fitting with Timestamp Preservation (TRAP 2)
  assert.ok(board.geometry, 'board.geometry must exist');
  const strokeRes = await board.geometry.fitStroke([
    { x: 0, y: 0, p: 0.5, t: 100 },
    { x: 1, y: 1, p: 0.6, t: 150 },
    { x: 3, y: 3, p: 0.7, t: 200 }
  ], 0.5);
  assert.equal(strokeRes.original_count, 3);
  assert.equal(strokeRes.simplified_count, 2);
  assert.equal(calls[calls.length - 1].cmd, 'stroke_simplify_and_fit');
  assert.equal(calls[calls.length - 1].args.epsilon, 0.5);

  // 4. Trigram Full-Text Search, Knowledge Graph & Flashcard SRS API
  assert.ok(board.search, 'board.search must exist');
  await board.search.indexBoard('b1', 'Calculus', 'The fundamental theorem of calculus', 'math,derivatives');
  assert.equal(calls[calls.length - 1].cmd, 'search_index_board');

  const searchHits = await board.search.query('integral', 10);
  assert.equal(searchHits.length, 1);
  assert.equal(searchHits[0].board_id, 'board-1');

  await board.search.recordLinks('b1', 'Calculus', [{ target_board_id: 'b2', target_title: 'Physics', edge_type: 'wikilink' }]);
  assert.equal(calls[calls.length - 1].cmd, 'graph_record_links');

  const backlinks = await board.search.getBacklinks('b1');
  assert.equal(backlinks[0].source_board_id, 'board-2');

  await board.search.upsertCard('c1', 'b1', 'Ohm\'s Law', 1700000000);
  assert.equal(calls[calls.length - 1].cmd, 'study_card_upsert');

  const dueCards = await board.search.getDueCards(1700000000, 20);
  assert.equal(dueCards[0].card_id, 'c1');

  // 5. Hardware Power & Battery Status API
  assert.ok(board.power, 'board.power must exist');
  const powerStatus = await board.power.getStatus();
  assert.equal(powerStatus.battery_percent, 98);
  assert.equal(calls[calls.length - 1].cmd, 'get_power_status');
});
