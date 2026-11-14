// live_check.mjs — one real pi-tool round trip against the running watcher.
// Purpose: prove that a normal successful call leaves no command file behind (v0.7.2).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL = 'C:/Users/a5093/.dsh/pixinsight-mcp/scripts/pi-tool.mjs';
const CMD_DIR = 'C:/Users/a5093/.pixinsight-mcp/bridge/commands';
const RES_DIR = 'C:/Users/a5093/.pixinsight-mcp/bridge/results';
const MASTER = 'D:/astro/M27run/02_masters/M27_H.xisf';

function listing(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return [];
  }
}

function run(tool, args, label) {
  const tmp = path.join(os.tmpdir(), `piargs_${tool}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(args), 'utf-8');
  const started = Date.now();
  const r = spawnSync(process.execPath, [TOOL, tool, '@' + tmp], {
    encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 600000,
  });
  try { fs.unlinkSync(tmp); } catch {}
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  // Give the watcher a beat to finish its own bookkeeping, then look.
  const cmdAfter = listing(CMD_DIR);
  const resAfter = listing(RES_DIR);

  console.log(`\n=== ${label || tool}  (${secs}s, exit=${r.status}) ===`);
  const out = (r.stdout || '').trim();
  console.log(out.length > 900 ? out.slice(0, 900) + ' …' : out);
  if (r.status !== 0) {
    const e = (r.stderr || '').trim();
    if (e) console.log('stderr: ' + e.split(/\r?\n/).slice(-6).join('\n'));
  }
  console.log(`queue after call -> commands: ${cmdAfter.length}  results: ${resAfter.length}`);
  if (cmdAfter.length) console.log('LEFTOVER commands: ' + cmdAfter.join(', '));
  return { status: r.status, out, cmdAfter };
}

console.log('before  -> commands:', listing(CMD_DIR).length, ' results:', listing(RES_DIR).length);

// 1. open a master (real work, exercises ImageWindow.open + stats)
run('pjsr', {
  code: `
    var stale = ImageWindow.windows.slice();
    for (var i = 0; i < stale.length; i++) stale[i].forceClose();
    var wins = ImageWindow.open('${MASTER}');
    var w = null;
    for (var k = 0; k < wins.length; k++) {
      if (wins[k].mainView.id.indexOf('crop_mask') >= 0) wins[k].forceClose();
      else if (!w) w = wins[k];
    }
    if (!w) throw new Error('open failed');
    w.mainView.id = 'LIVE_H';
    var im = w.mainView.image;
    'LIVE_H ' + im.width + 'x' + im.height + ' ch=' + im.numberOfChannels +
    ' median=' + im.median().toFixed(6) + ' max=' + im.maximum().toFixed(4);
  `,
}, 'open M27_H');

// 2. a normal stats read through the regular tool path
run('measure_background', { view_id: 'LIVE_H', sample_percent: 0.05 }, 'measure_background');

// 3. close up shop
run('pjsr', { code: `var ws = ImageWindow.windows.slice(); for (var i = 0; i < ws.length; i++) ws[i].forceClose(); 'closed ' + ws.length;` }, 'close windows');

console.log('\n=== final ===');
console.log('commands:', listing(CMD_DIR).length, ' results:', listing(RES_DIR).length);
