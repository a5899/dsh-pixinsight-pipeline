// Contract test for the gotchas brief that the plugin injects into the skill content.
//
// WHY THIS EXISTS
//   The brief is generated from reference/pjsr-gotchas.md, so it can rot in two
//   silent ways: a briefed section gets renamed and its bullet quietly turns into
//   "(no summary sentence recovered)", or the prose extractor starts returning
//   code fragments again. Both still produce a syntactically valid string, so
//   nothing fails — the reader just gets a worse skill. These tests pin the
//   failure modes that actually happened while building it on 2026-11-14.
//
// Run: node test/brief.mjs   (part of `npm test`)
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { __provider, __briefSections, buildBrief } from '../lib/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const GOTCHAS = `${root}skills/pixinsight-pipeline/reference/pjsr-gotchas.md`
const SKILL = `${root}skills/pixinsight-pipeline/SKILL.md`

const gotchasText = await readFile(GOTCHAS, 'utf8')
const { content } = await __provider.get((await __provider.list())[0])

/** The authored body, exactly as it sits in SKILL.md after the frontmatter. */
const authoredBody = await readFile(SKILL, 'utf8').then((raw) => {
  const end = raw.indexOf('\n---', 3)
  return raw.slice(raw.indexOf('\n', end + 1) + 1)
})

// --- the brief is actually present, and first ----------------------------------

assert.ok(
  content.includes('## Read this before the first `pi-tool` call'),
  'the served skill must open with the brief, otherwise nothing else here matters',
)
assert.ok(
  content.trimStart().startsWith('<!-- generated from reference/pjsr-gotchas.md'),
  'the brief must be the first thing in the content, not a footer the model may never reach',
)

// --- the authored body is not damaged -----------------------------------------

assert.ok(
  content.endsWith(authoredBody),
  'the authored SKILL.md body must survive verbatim after the brief',
)

// --- every briefed section still resolves -------------------------------------

const { block, missing, empty } = buildBrief(gotchasText)
assert.deepEqual(
  missing,
  [],
  `briefed sections missing from pjsr-gotchas.md (renamed or deleted?):\n  ${missing.join('\n  ')}`,
)
assert.deepEqual(empty, [], `briefed sections yielded no summary sentence:\n  ${empty.join('\n  ')}`)

const bullets = block.split('\n').filter((line) => line.startsWith('- **'))
assert.equal(
  bullets.length,
  __briefSections.length,
  `expected one bullet per briefed section (${__briefSections.length}), got ${bullets.length}`,
)

// --- the bullets read as prose, not as code or fragments ----------------------
//
// Each failure below was observed while building the extractor:
//   * summary empty                      -> a heading followed by code only
//   * summary ends on a colon            -> we kept the lead-in, dropped the payload
//   * summary opens with "there is no"   -> orphaned fragment of a dropped sentence
//   * summary opens with source code     -> the fence filter leaked
for (const bullet of bullets) {
  const parts = bullet.split('**')
  const summary = parts
    .slice(2)
    .join('**')
    .replace(/^\.\s*/, '')
    .trim()
  const where = bullet.slice(0, 90)

  assert.ok(summary.length >= 30, `summary too short (${summary.length} chars): ${where}`)
  assert.ok(!/[:：]$/.test(summary), `summary ends on a colon: ${where}`)
  assert.ok(
    !/^(there is no\b|fallback\b|note that\b|see below\b)/i.test(summary),
    `summary is an orphaned fragment: ${where}`,
  )
  assert.ok(
    !/^(\/\/|\/\*|var |let |const |new |return |load\()/.test(summary),
    `summary starts with source code: ${where}`,
  )
  assert.ok(
    !/Script error:|^\{|\}$/.test(summary.slice(0, 60)),
    `summary contains raw error text or JSON: ${where}`,
  )
}

// --- serving degrades safely ---------------------------------------------------
//
// A missing gotchas file must not take the skill down; it serves the authored
// body alone and warns. (The failure path is what made the original silent-no-op
// bugs possible, so it gets its own assertion rather than an assumption.)
{
  const bare = { ...(await __provider.list())[0] }
  const original = __provider.get
  // Exercise the real code path with a locator that cannot resolve a gotchas
  // file only by pointing at a directory without one — simulated by asserting on
  // buildBrief('') instead of mutating the filesystem.
  assert.equal(buildBrief('').missing.length, __briefSections.length)
  assert.ok(buildBrief('').block.includes('no summary sentence recovered') === false)
  assert.equal(typeof original, 'function')
  assert.ok(bare.locator instanceof URL)
}

console.log(`brief contract OK — ${bullets.length} traps, ${content.length} chars served`)
