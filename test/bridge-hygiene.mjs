// Offline test for bridge command-file hygiene.
//
// The bug this locks down: commands/<id>.json files survived after their node
// side gave up (timeout, PI crash, host restart), because nothing on the node
// side ever looked at commands/. They were replayed on the next PixInsight
// start — re-running pjsr/PixelMath commands and raising a modal error dialog
// for every command that pointed at a since-deleted file. Observed pile-ups:
// 46, 113 and 83 files in a single day.
//
// PixInsight is NOT required: a tiny fake watcher answers commands by writing
// results/<id>.json, exactly like the real one, and we assert on the directory.
//
// Run: node test\bridge-hygiene.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bridgeUrl = pathToFileURL(
  path.join(root, 'lib', 'pixinsight-mcp', 'agents', 'ops', 'bridge.mjs')).href;

// Sleep that never blocks longer than the code under test needs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bridge-${name}-`));
  const cmdDir = path.join(dir, 'commands');
  const resDir = path.join(dir, 'results');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });
  return { dir, cmdDir, resDir, heartbeatFile: path.join(dir, 'watcher.heartbeat') };
}

/** Spin up a fake idle watcher: fresh heartbeat, and results written on request. */
function fakeWatcher(box) {
  const touch = () => fs.writeFileSync(box.heartbeatFile, String(Date.now()));
  touch();
  const iv = setInterval(touch, 200);
  return {
    stop() { clearInterval(iv); },
    /** Answer every pending command with a plain ok result. */
    async answerAll() {
      for (const f of fs.readdirSync(box.cmdDir)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        fs.writeFileSync(path.join(box.resDir, id + '.json'),
          JSON.stringify({ id, status: 'ok', outputs: { consoleOutput: 'done' } }));
      }
    },
  };
}

const { createBridgeContext } = await import(bridgeUrl);

const failures = [];
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { failures.push(`${label}: ${err.message}`); console.log(`  FAIL ${label}\n       ${err.message}`); }
}

// ---------------------------------------------------------------------------
// 1. A successful send leaves no command file behind
// ---------------------------------------------------------------------------
{
  console.log('\nbridge hygiene — successful send');
  const box = sandbox('ok');
  const watcher = fakeWatcher(box);
  const ctx = createBridgeContext({
    cmdDir: box.cmdDir, resDir: box.resDir,
    heartbeatFile: box.heartbeatFile, log: () => {},
  });
  // Answer as soon as the command lands.
  const poll = setInterval(() => { watcher.answerAll().catch(() => {}); }, 30);
  const result = await ctx.pjsr('1 + 1');
  clearInterval(poll);
  watcher.stop();

  check('the call succeeded', () => assert.equal(result.status, 'ok'));
  check('commands/ is empty after success', () => {
    const left = fs.readdirSync(box.cmdDir);
    assert.deepEqual(left, [], `leftover: ${left.join(', ')}`);
  });
  check('results/ is empty after success', () => {
    assert.deepEqual(fs.readdirSync(box.resDir), []);
  });
  fs.rmSync(box.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. A send that never gets answered also retires its command file
//
// Two distinct exits are possible and both must clean up:
//   - no watcher and no PixInsight  -> BridgeCrashError from the liveness check
//   - watcher alive but silent     -> "Timeout: run_script"
// The pile-up this test guards against came from the silent-watcher case, but
// the crashed-PI case leaves files behind just as readily.
// ---------------------------------------------------------------------------
{
  console.log('\nbridge hygiene — unanswered send');
  const box = sandbox('timeout');
  // No watcher and no PixInsight: the liveness check gives up first.
  const ctx = createBridgeContext({
    cmdDir: box.cmdDir, resDir: box.resDir,
    heartbeatFile: box.heartbeatFile, log: () => {},
  });
  let threw = null;
  try { await ctx.pjsr('1 + 1', { timeoutMs: 400 }); }
  catch (err) { threw = err; }
  check('the call failed instead of hanging', () => {
    assert.ok(threw, 'expected an error');
    assert.match(threw.message, /Timeout: run_script|process not found/,
      `unexpected error: ${threw.message}`);
  });
  check('commands/ is empty after an unanswered send', () => {
    const left = fs.readdirSync(box.cmdDir);
    assert.deepEqual(left, [], `leftover: ${left.join(', ')}`);
  });
  fs.rmSync(box.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2b. Silent-watcher timeout: heartbeat fresh, PixInsight "running", but the
//     command is never answered. This is the exact shape of the 83-file pile-up.
// ---------------------------------------------------------------------------
{
  console.log('\nbridge hygiene — silent watcher timeout');
  const box = sandbox('silent');
  const watcher = fakeWatcher(box);          // keeps the heartbeat fresh, never answers
  const ctx = createBridgeContext({
    cmdDir: box.cmdDir, resDir: box.resDir,
    heartbeatFile: box.heartbeatFile, log: () => {},
  });
  let threw = null;
  try { await ctx.pjsr('1 + 1', { timeoutMs: 300 }); }
  catch (err) { threw = err; }
  watcher.stop();
  check('the call timed out rather than reporting a crash', () => {
    assert.ok(threw, 'expected a timeout error');
    assert.match(threw.message, /Timeout: run_script/, `unexpected error: ${threw.message}`);
  });
  check('commands/ is empty after the timeout', () => {
    const left = fs.readdirSync(box.cmdDir);
    assert.deepEqual(left, [], `leftover: ${left.join(', ')}`);
  });
  fs.rmSync(box.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. Creating a context clears abandoned commands older than the cutoff
// ---------------------------------------------------------------------------
{
  console.log('\nbridge hygiene — abandoned files at context creation');
  const box = sandbox('stale');
  const now = Date.now();
  const old = new Date(now - 10 * 60_000);          // 10 min: past the 5 min cutoff
  const fresh = new Date(now - 1_000);              // 1 s: could still be pending

  const writeStale = (name, when) => {
    const fp = path.join(box.cmdDir, name);
    fs.writeFileSync(fp, JSON.stringify({ id: name.replace('.json', '') }));
    fs.utimesSync(fp, when, when);
  };
  writeStale('aaaaaaaa-old.json', old);
  writeStale('bbbbbbbb-old.ready', old);
  writeStale('cccccccc-fresh.json', fresh);

  createBridgeContext({
    cmdDir: box.cmdDir, resDir: box.resDir,
    heartbeatFile: box.heartbeatFile, log: () => {},
  });

  const left = fs.readdirSync(box.cmdDir).sort();
  check('the abandoned command was removed', () => assert.ok(!left.includes('aaaaaaaa-old.json'),
    `still there: ${left.join(', ')}`));
  check('the abandoned .ready marker was removed', () => assert.ok(!left.includes('bbbbbbbb-old.ready'),
    `still there: ${left.join(', ')}`));
  check('a command that could still be pending was kept', () => assert.ok(left.includes('cccccccc-fresh.json'),
    `missing, kept: ${left.join(', ')}`));
  fs.rmSync(box.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. .ready and .tmp siblings are retired with the command
// ---------------------------------------------------------------------------
{
  console.log('\nbridge hygiene — sibling suffixes');
  const box = sandbox('siblings');
  const watcher = fakeWatcher(box);
  const ctx = createBridgeContext({
    cmdDir: box.cmdDir, resDir: box.resDir,
    heartbeatFile: box.heartbeatFile, log: () => {},
  });
  const poll = setInterval(() => {
    for (const f of fs.readdirSync(box.cmdDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      // A slow writer leaves .ready behind; simulate it landing late.
      fs.writeFileSync(path.join(box.cmdDir, id + '.ready'), '1');
    }
    watcher.answerAll().catch(() => {});
  }, 30);
  await ctx.pjsr('1 + 1');
  clearInterval(poll);
  watcher.stop();
  check('no .json / .ready / .tmp leftovers', () => {
    const left = fs.readdirSync(box.cmdDir);
    assert.deepEqual(left, [], `leftover: ${left.join(', ')}`);
  });
  fs.rmSync(box.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
await sleep(50);
if (failures.length) {
  console.error(`\n${failures.length} bridge hygiene check(s) FAILED`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nbridge hygiene contract OK — no command file outlives its caller');
