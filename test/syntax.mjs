// Syntax + export invariants for every ops module.
//
// node --check per file (one process per file, because a single pwsh command
// running many node processes is flaky on this host), plus a check that
// pi-tool.mjs keeps its imports resolvable and its tool table unique.
//
// Run: node test\syntax.mjs   (or `npm test`, which runs all three suites)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const opsDir = path.join(root, 'lib', 'pixinsight-mcp', 'agents', 'ops');

let failed = 0;
for (const file of fs.readdirSync(opsDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const abs = path.join(opsDir, file);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    console.log(`ok  syntax  ${file}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL syntax  ${file}\n${err.stderr?.toString() || err.message}`);
  }
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

if (failed) {
  console.error(`\n${failed} file(s) failed syntax check`);
  process.exitCode = 1;
} else {
  console.log('\nall syntax checks passed');
}
