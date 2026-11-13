'use strict';
// Release notes come from release-notes/<version>.md and are published by the
// release workflows on their own - desktop and Android alike - so a green build
// needs no hand-editing of the release page afterwards. These checks run the
// workflows' own shell steps against a scratch folder and read what they write.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
// Windows checkouts can carry CRLF line endings; the workflows run on Linux with LF
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/*
 * A real bash to run the workflows' steps with. On Windows a plain "bash" is
 * usually the WSL launcher, which fails when no Linux is installed - so look
 * for the one that comes with Git for Windows instead. If there is none, the
 * steps are not run here (the CI runners, which are Linux, still run them)
 * and the test says so rather than failing.
 */
function findBash() {
  const works = (b) => {
    try { return execFileSync(b, ['-c', 'echo ok'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'ok'; }
    catch { return false; }
  };
  if (process.platform !== 'win32') return works('bash') ? 'bash' : null;
  const tried = [];
  const candidates = [];
  try {
    const git = execFileSync('where', ['git'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/).filter(Boolean);
    for (const g of git) candidates.push(path.join(path.dirname(g), '..', 'bin', 'bash.exe'), path.join(path.dirname(g), '..', 'usr', 'bin', 'bash.exe'));
  } catch { /* no git on PATH */ }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  for (const c of candidates) { tried.push(c); if (fs.existsSync(c) && works(c)) return c; }
  findBash.tried = tried;
  return null;
}
const BASH = findBash();
const noBash = () => `no usable bash here (Windows "bash" is the WSL launcher; looked for Git Bash at: ${(findBash.tried || []).join(', ') || 'nowhere'}) - the CI runners still run these steps`;

/** The `run: |` block of the step called `name`, de-indented. Every match, in order. */
function runBlocks(yml, name) {
  const lines = yml.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^\\s*- name: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*run: \|\s*$/.test(lines[j])) j++;
    const body = [];
    const indent = (lines[j + 1].match(/^\s*/) || [''])[0].length;
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k].trim() && (lines[k].match(/^\s*/) || [''])[0].length < indent) break;
      body.push(lines[k].slice(indent));
    }
    out.push(body.join('\n'));
  }
  return out;
}

/** Paragraphs that were wrapped by hand: two non-blank lines in a row that are not a list, table or heading. */
function wrappedLines(md) {
  const ls = md.split('\n');
  const bad = [];
  const plain = (l) => l.trim() && !/^\s*([-*+]|\d+\.|#|\||>|```)/.test(l);
  for (let i = 1; i < ls.length; i++) if (plain(ls[i]) && plain(ls[i - 1])) bad.push(`line ${i}: "${ls[i - 1].slice(0, 50)}…" then "${ls[i].slice(0, 50)}…"`);
  return bad;
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gb-notes-'));

test('desktop: every platform that attaches files to the release takes its text from release-notes/<version>.md', () => {
  const yml = read('.github/workflows/tauri-release.yml');
  const attaches = yml.split('- name: Attach branch binaries to GitHub Release').slice(1).map((s) => s.split('\n      - name:')[0]);
  assert.equal(attaches.length, 1, `expected Windows build job to attach to the release, found ${attaches.length}`);
  attaches.forEach((a, i) => {
    assert.match(a, /body_path: \$\{\{ steps\.notes\.outputs\.path \}\}/, `attach step ${i + 1} does not read the notes file:\n${a}`);
    assert.match(a, /generate_release_notes: \$\{\{ steps\.notes\.outputs\.generate == 'true' \}\}/, `attach step ${i + 1} still always generates notes:\n${a}`);
  });
  assert.equal(runBlocks(yml, 'Find the release notes for this version').length, 1,
    'the attaching job needs its own "Find the release notes for this version" step');
});

test('desktop: the notes step points at the file when it exists, and falls back to GitHub\'s list when it does not', (t) => {
  if (!BASH) { t.skip(noBash()); return; }
  const script = runBlocks(read('.github/workflows/tauri-release.yml'), 'Find the release notes for this version')[0];
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'release-notes'));
  fs.writeFileSync(path.join(dir, 'release-notes', '9.9.9.md'), 'Hello.\n');
  const outputs = (tag) => {
    const out = 'out-' + tag;            // relative to the scratch folder, so no Windows path goes through bash
    fs.writeFileSync(path.join(dir, out), '');
    execFileSync(BASH, ['-c', script], { cwd: dir, env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: out }, stdio: 'pipe' });
    return fs.readFileSync(path.join(dir, out), 'utf8').replace(/\r\n/g, '\n');
  };
  const have = outputs('v9.9.9');
  assert.match(have, /path=release-notes\/9\.9\.9\.md/, `with the file present the step wrote:\n${have}`);
  assert.match(have, /generate=false/, `with the file present it should not also generate notes:\n${have}`);
  const missing = outputs('v1.0.0');
  assert.match(missing, /path=\n/, `with no file the path should be empty:\n${missing}`);
  assert.match(missing, /generate=true/, `with no file it should fall back to generated notes:\n${missing}`);
});

test('android: the release workflow attaches release-notes/<version>.md and builds signed aarch64 APKs', (t) => {
  const yml = read('.github/workflows/tauri-android.yml');
  assert.match(yml, /tauri android build -- --apk --target aarch64/, 'tauri-android.yml must build signed aarch64 APKs');
  const attaches = yml.split('- name: Attach signed APK to GitHub Release').slice(1).map((s) => s.split('\n      - name:')[0]);
  assert.equal(attaches.length, 1, `expected Android workflow to attach to the release once, found ${attaches.length}`);
  assert.match(attaches[0], /body_path: \$\{\{ steps\.notes\.outputs\.path \}\}/, `Android attach step does not read the notes file:\n${attaches[0]}`);
  assert.match(attaches[0], /generate_release_notes: \$\{\{ steps\.notes\.outputs\.generate == 'true' \}\}/, `Android attach step does not fall back to generated notes`);
  if (!BASH) { t.skip(noBash()); return; }
  const script = runBlocks(yml, 'Find the release notes for this version')[0];
  assert.ok(script, 'tauri-android.yml is missing Find the release notes for this version step');
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'release-notes'));
  fs.writeFileSync(path.join(dir, 'release-notes', '9.9.9.md'), '# Release 9.9.9\n\nSingle line paragraph.\n');
  const out = 'out-android';
  fs.writeFileSync(path.join(dir, out), '');
  execFileSync(BASH, ['-c', script], { cwd: dir, env: { ...process.env, GITHUB_REF_NAME: 'v9.9.9', GITHUB_OUTPUT: out }, stdio: 'pipe' });
  const result = fs.readFileSync(path.join(dir, out), 'utf8').replace(/\r\n/g, '\n');
  assert.match(result, /path=release-notes\/9\.9\.9\.md/, `Android notes lookup failed:\n${result}`);
  assert.match(result, /generate=false/);
});

test('every release-notes file keeps each paragraph on one line', () => {
  const dir = path.join(ROOT, 'release-notes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  assert.ok(files.length > 0, 'there is no release-notes/<version>.md yet');
  for (const f of files) {
    const wrapped = wrappedLines(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
    assert.deepEqual(wrapped, [], `${f} has paragraphs wrapped across lines:\n${wrapped.join('\n')}`);
  }
});

test('the version being released has its notes written', () => {
  const v = JSON.parse(read('package.json')).version;
  const f = path.join(ROOT, 'release-notes', v + '.md');
  assert.ok(fs.existsSync(f), `package.json says ${v} but release-notes/${v}.md does not exist - the release would go out with generated notes`);
});
