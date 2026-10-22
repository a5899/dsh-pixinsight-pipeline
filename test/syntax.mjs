// Syntax + export invariants for every ops module and every toolkit script.
//
// node --check per file (one process per file, because a single pwsh command
// running many node processes is flaky on this host), plus a check that
// pi-tool.mjs keeps its imports resolvable and its tool table unique.
//
// Run: node test\syntax.mjs   (or `npm test`, which runs all four suites)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const opsDir = path.join(root, 'lib', 'pixinsight-mcp', 'agents', 'ops');
const scriptsDir = path.join(root, 'lib', 'pixinsight-mcp', 'scripts');

let failed = 0;

/** node --check one file, recording a failure instead of throwing. */
function checkSyntax(abs) {
  const label = path.relative(root, abs);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    console.log(`ok  syntax  ${label}`);
    return true;
  } catch (err) {
    failed += 1;
    console.error(`FAIL syntax  ${label}\n${err.stderr?.toString() || err.message}`);
    return false;
  }
}

for (const file of fs.readdirSync(opsDir).filter((f) => f.endsWith('.mjs')).sort()) {
  checkSyntax(path.join(opsDir, file));
}

// The toolkit CLI scripts (pi-tool, find-masters, clean-wbpp, resolve-toolkit) are the
// ones an agent actually executes, so a syntax error there is worse than in an ops module.
for (const file of fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).sort()) {
  checkSyntax(path.join(scriptsDir, file));
}

// pi-tool.mjs: every relative import must resolve, and the case table must not
// contain a duplicate command name (a duplicate silently shadows the first).
const toolPath = path.join(root, 'lib', 'pixinsight-mcp', 'scripts', 'pi-tool.mjs');
const src = fs.readFileSync(toolPath, 'utf8');

const importRe = /from\s+'(\.\.?\/[^']+)'/g;
let m;
let imports = 0;
for (m = importRe.exec(src); m; m = importRe.exec(src)) {
  const target = path.resolve(path.dirname(toolPath), m[1]);
  assert.ok(fs.existsSync(target), `pi-tool.mjs imports missing file: ${m[1]}`);
  imports += 1;
}
console.log(`ok  imports  ${imports} relative imports resolve`);

const cases = [...src.matchAll(/case '([a-z0-9_]+)':/g)].map((x) => x[1]);
const dupes = cases.filter((name, i) => cases.indexOf(name) !== i);
assert.deepEqual([...new Set(dupes)], [], `duplicate command cases: ${[...new Set(dupes)].join(', ')}`);
console.log(`ok  commands  ${cases.length} unique case labels`);

// PowerShell scripts containing non-ASCII text MUST carry a UTF-8 BOM. Windows
// PowerShell 5.1 (the default on zh-CN Windows) decodes BOM-less files as GBK, so the
// Chinese comments become mojibake and a quoted string can lose its terminator —
// `install-into-dsh.ps1` was unparseable exactly this way and the install silently never ran.
const psFiles = [
  path.join(root, 'lib', 'pixinsight-mcp', 'run-wbpp.ps1'),
  ...fs
    .readdirSync(path.join(root, 'scripts'))
    .filter((f) => f.endsWith('.ps1'))
    .map((f) => path.join(root, 'scripts', f)),
];

for (const abs of psFiles) {
  const rel = path.relative(root, abs);
  const bytes = fs.readFileSync(abs);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const hasNonAscii = bytes.some((b) => b > 0x7f);
  if (hasNonAscii) {
    assert.ok(hasBom, `${rel} contains non-ASCII text but has no UTF-8 BOM (PowerShell 5.1 will misparse it)`);
    console.log(`ok  ps-bom  ${rel}`);
  } else {
    console.log(`ok  ps-bom  ${rel} (ASCII only, BOM not required)`);
  }
  // Whatever the encoding, the script must actually parse.
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${abs.replace(/'/g, "''")}',[ref]$null,[ref]$e);if($e){exit 1}`],
      { stdio: 'pipe' },
    );
  } catch {
    failed += 1;
    console.error(`FAIL parse  ${rel}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed syntax check`);
  process.exitCode = 1;
} else {
  console.log('\nall syntax checks passed');
}
