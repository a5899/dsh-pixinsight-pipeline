/**
 * dsh-pixinsight-pipeline — DeepSeek Harness plugin entry.
 *
 * Registers the bundled `pixinsight-pipeline` skill with the host skill
 * registry, so the pack ships as a normal DSH plugin instead of relying on a
 * copy under the user-level skills root. The skill's executable half lives in
 * ./lib/pixinsight-mcp/ (pi-tool CLI + PJSR watcher + WBPP wrapper), which the
 * install script places at `%DSH_HOME%/pixinsight-mcp/`.
 *
 * IMPORTANT — module shape constraints (mirrors dsh-creative-studio):
 *   The host loads profile bundles through a CommonJS-compatible path, so a
 *   top-level-await module fails with ERR_REQUIRE_ASYNC_MODULE and the plugin
 *   silently never registers. Keep this file TLA-free: static imports only, and
 *   any optional dynamic import must happen inside an async function.
 *
 * Contract mirrors first-party plugins: `inject = ['skills']` plus
 * `ctx.skills.registerProvider(() => provider)`, where the provider exposes
 * `name`, `list()` and `get(candidate)`; every candidate carries a finite
 * numeric `rank`.
 *
 * WHY THE BRIEF EXISTS
 *   `reference/pjsr-gotchas.md` documents every failure this pipeline has paid
 *   for, but a reference file only reaches the model if the model chooses to
 *   open it, and in practice it does not: on 2026-11-14 a full M45 run re-learned
 *   the save_variant backslash bug, eight inert crop forms, four parser errors on
 *   one HistogramTransformation table, and a 113-command bridge backlog — all of
 *   which were documented or derivable. Telling the reader "please read the
 *   gotchas first" in prose does not work.
 *
 *   So the top of the skill content now carries a generated brief: the
 *   highest-cost traps in the form the model sees whether it wants to or not.
 *   The brief is DERIVED from pjsr-gotchas.md at get() time, not hand-copied,
 *   so it cannot drift from the reference; if a section disappears the brief
 *   loses that line, and the self-check below fails loudly instead.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pixinsight-pipeline'
export const inject = ['skills']

const PROVIDER_NAME = 'pixinsight-pipeline'
const INVOCATION = { modelInvocable: true, userInvocable: true }

/**
 * Host precedence rank. Pinned from @deepseek-ai/dsh-skill
 * (`BUNDLED_SKILL_RANK = 600`), the documented value for packaged providers;
 * the registry rejects candidates whose rank is missing or not a finite number.
 * `resolveRank()` opportunistically reads the host constant at list() time
 * without introducing top-level await.
 */
const DEFAULT_RANK = 600

/** Skills shipped inside this package (directory name === skill name). */
const SKILL_DIRS = ['pixinsight-pipeline']

const PACKAGE_ROOT = new URL('../', import.meta.url)

/**
 * The traps that have actually cost a run. Each entry is
 *   [ section heading in pjsr-gotchas.md, one-line cost form, optional summary ]
 *
 * Without a third field the summary is the section's opening paragraph, which is
 * usually but not always the actionable sentence. Supply the third field when a
 * section opens with context and buries the rule; a supplied summary must still
 * name a real heading, so renaming a section in the gotchas breaks the brief
 * loudly instead of silently dropping the trap.
 */
const BRIEF_SECTIONS = [
  ['A silent `ok:true` is normal — always verify on disk', 'ok:true does not mean a file exists — stat it'],
  [
    'Prefer `pisave.mjs` / `piopen.mjs` over save_variant / load_variant',
    'save_variant eats Windows backslashes into PJSR escapes',
    'Reach for `pisave.mjs` (view → absolute path) and `piopen.mjs` (absolute path → new view id) instead. Both take a forward-slashed absolute path, verify `File.exists` themselves, and refuse to return success for a file that is not on disk.',
  ],
  [
    '`image.crop()` — works, but only on a WRITABLE image',
    'crop is inert on a disk-loaded (read-only) image',
    'An image opened from disk is read-only: `crop()` and `cropTo()` silently change nothing, or throw `read-only image`. Copy it into a fresh `ImageWindow` with `assign()`, crop that, then assert the resulting width/height — every other form looks like it worked. `cropTo(x0, y0, x1, y1)` takes four ints with an exclusive right/bottom edge.',
  ],
  [
    'ImageWindow Constructor — "invalid dimension(s)" means you passed 0',
    'that error means the source window was never open',
    'The message never means the numbers were the wrong type. It means they were out of range — in practice 0 — because `windowById()` returned a null window for an id that was never opened. Guard the source: `if (w.isNull) throw …` and `if (im.width < 100) throw …` before constructing anything.',
  ],
  [
    '`HistogramTransformation.H` — the documented layout is wrong for this build',
    'the 5-tuple layout is not a valid table here',
    '`H` is a 5-column table here, 5 rows of `[0, 0.5, 1, 0, 1]` by default. A 6-row table throws `table length out of range (6)`; a value above 0.5 in the third column throws `numeric value out of range`. For a plain midtone shift, use the PixelMath MTF form the tools use instead of hand-building `H`.',
  ],
  ['PixelMath single expression: no `var` statements', 'a multi-line expression silently changes nothing'],
  ['Files written by `saveAs()` stay locked (EBUSY) until PixInsight quits', 'close PI before reading what it wrote'],
  ['`seti_stretch` mutates the view in place', 'save a linear copy before you stretch'],
  ['`separate_stars` returns `ok:true` with pure-black output windows', 'read back max(), not the ok flag'],
  ['`shrink_stars` — amount below ~0.2 is a silent no-op', 'too small does nothing, too large erases the stars'],
  ['The auto-STF preview\'s white core is NOT clipping', 'a white centre in the preview is not saturation'],
  ['Block-median grids CANNOT prove a faint extended target is absent', 'crop onto the target before saying it is missing'],
  ['Bridge command queue: the node side now retires its own commands', 'stale commands replay as modal error dialogs', 'Retired automatically since v0.7.2. A backlog on an up-to-date install means a plugin older than 0.7.2, a command younger than the 5-minute cutoff whose caller died, or a run still in flight — check count and timestamps first, and never resend a timed-out command in a loop.'],
  ['Pass tool arguments through a JSON file, not the command line', 'PowerShell eats the quotes in inline JSON'],
]

const GOTCHAS_REL = (dir) => `../skills/${dir}/reference/pjsr-gotchas.md`

function gotchasUrl(dir) {
  return new URL(GOTCHAS_REL(dir), import.meta.url)
}

let rankPromise = null

function resolveRank() {
  rankPromise ??= (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-skill')
      if (typeof mod?.BUNDLED_SKILL_RANK === 'number') return mod.BUNDLED_SKILL_RANK
    } catch {
      // Host package not resolvable from this path — fall back to the pinned value.
    }
    return DEFAULT_RANK
  })()
  return rankPromise
}

function skillFileUrl(dir) {
  return new URL(`../skills/${dir}/SKILL.md`, import.meta.url)
}

function skillResourceBase(dir) {
  return {
    kind: 'directory',
    path: fileURLToPath(new URL(`../skills/${dir}/`, import.meta.url)),
  }
}

/**
 * Minimal frontmatter reader: enough for `name:`, `description:` and `whenToUse:`.
 *
 * Must understand the block-scalar forms (`|`, `|-`, `>`, `>-`). SKILL.md writes its
 * description that way because it is thirteen lines long, and a single-line reader
 * yields the literal `|` as the description — which is exactly what shipped to the
 * skill catalog before this was fixed. A bare `|` is a lie about the skill, and the
 * catalog is the only thing a reader sees before deciding whether to load it.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const head = text.slice(3, end)
  const body = text.slice(text.indexOf('\n', end + 1) + 1)
  const data = {}
  const lines = head.split('\n')
  let pendingKey = null
  let pendingBlock = []
  let pendingFold = false

  const flushBlock = () => {
    if (pendingKey === null) return
    // Block scalars are written with a common indent; strip the smallest one that
    // appears on a non-blank line, otherwise every line keeps two leading spaces.
    const nonBlank = pendingBlock.filter((line) => line.trim() !== '')
    const indent = nonBlank.length
      ? Math.min(...nonBlank.map((line) => line.match(/^\s*/)[0].length))
      : 0
    const dedented = pendingBlock.map((line) => line.slice(Math.min(indent, line.length)))
    const joined = pendingFold
      // Folded scalars join with spaces; blank lines become paragraph breaks.
      ? dedented
          .join('\n')
          .split(/\n{2,}/)
          .map((para) => para.split('\n').map((l) => l.trim()).filter(Boolean).join(' '))
          .filter(Boolean)
          .join('\n\n')
      // Literal scalars keep their line breaks.
      : dedented.join('\n')
    data[pendingKey] = joined.trim()
    pendingKey = null
    pendingBlock = []
    pendingFold = false
  }

  for (const rawLine of lines) {
    const indented = /^\s+\S/.test(rawLine)
    if (pendingKey !== null) {
      // Block scalar continues while lines are indented (or blank).
      if (indented || rawLine.trim() === '') {
        pendingBlock.push(rawLine)
        continue
      }
      flushBlock()
    }
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (/^[|>][+-]?$/.test(value)) {
      pendingKey = key
      pendingFold = value.startsWith('>')
      pendingBlock = []
      continue
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  flushBlock()
  return { data, body }
}

/**
 * First plausible prose paragraph of a `##` section, flattened to one line.
 *
 * Sections in the gotchas follow a loose structure: heading → prose → evidence
 * (code blocks, tables, bullet lists). Only the prose carries the *meaning*;
 * the evidence carries the numbers. Earlier versions flattened the evidence too
 * and produced bullets that opened with `// what actually happened in the M27
 * run` and ended mid-sentence on a dangling colon — technically first lines,
 * useless as a reminder.
 *
 * So: drop fenced blocks entirely, drop table and list lines, drop lines that
 * are obviously code, and require the result to be a sentence that ends like
 * one before the cap truncates it.
 */
function firstParagraph(sectionText, limit = 220) {
  const withoutHeading = sectionText.replace(/^##[^\n]*\n/, '')
  const lines = withoutHeading.split('\n')
  const kept = []
  const rawProse = []
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inFence = !inFence
      // A fence ends a paragraph: anything after it is evidence for the one above.
      kept.push('')
      continue
    }
    if (inFence) continue
    if (!trimmed) {
      kept.push('')
      continue
    }
    // Evidence, not prose.
    if (/^(\||>|[-*+]\s|\d+[.)]\s)/.test(trimmed)) continue
    // Code shapes that survive as bare lines: declarations, calls, comments.
    if (/^(\/\/|\/\*|var |let |const |if\s*\(|for\s*\(|function |new |return |throw |\}\s*$)/.test(trimmed)) continue
    if (/[;{}]\s*$/.test(trimmed) && !/[.:,]\s+/.test(trimmed)) continue
    rawProse.push(trimmed)
    kept.push(trimmed)
  }

  const usable = (flat) => {
    if (flat.length < 40) return false
    if (/[:：]$/.test(flat)) return false
    // A fragment that opens with "there is no X." / "fallback that worked" only
    // makes sense in the context of the sentence we already dropped.
    if (/^(there is no\b|fallback\b|note that\b|see below\b)/i.test(flat)) return false
    if (!/[.!?。！？]$/.test(flat) && flat.length < 80) return false
    return true
  }
  const flatten = (text) =>
    text
      .split('\n')
      .join(' ')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  for (const block of kept.join('\n').split(/\n\s*\n/)) {
    const flat = flatten(block)
    if (usable(flat)) return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat
  }

  // Fallback: some sections open straight into evidence and their only real
  // sentence sits further down. Take the first prose line that reads like one
  // rather than emitting an empty bullet.
  const joined = flatten(rawProse.join(' '))
  const sentences = joined.split(/(?<=[.!?。！？])\s+/)
  for (const sentence of sentences) {
    const candidate = sentence.trim()
    if (usable(candidate)) return candidate.length > limit ? `${candidate.slice(0, limit - 1).trimEnd()}…` : candidate
  }
  return ''
}

/** Split a gotchas file into `## heading` → section text. */
function indexSections(text) {
  const sections = new Map()
  const lines = text.split('\n')
  let current = null
  let buffer = []
  const flush = () => {
    if (current) sections.set(current, buffer.join('\n'))
    buffer = []
  }
  for (const line of lines) {
    if (/^## /.test(line)) {
      flush()
      current = line.slice(3).trim()
    } else if (current) {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

/**
 * Build the contract block prepended to the skill body.
 *
 * Returns { block, missing } where `missing` lists briefed sections that were
 * not found. Callers decide how loud to be: `get()` still serves the skill with
 * whatever was found (a documentation gap must not disable the plugin), but the
 * missing headings are surfaced so they get fixed instead of rotting silently.
 */
export function buildBrief(gotchasText) {
  const sections = indexSections(gotchasText)
  const lines = []
  const missing = []
  const empty = []
  for (const [heading, cost, summary] of BRIEF_SECTIONS) {
    const found = sections.get(heading)
    if (found === undefined) {
      missing.push(heading)
      continue
    }
    const paragraph = summary || firstParagraph(found, 420)
    if (!paragraph) {
      // Keep the cost line — a trap with no extracted sentence is still a trap,
      // but say so plainly instead of emitting a bullet that trails off.
      empty.push(heading)
      lines.push(`- **${cost}.** (no summary sentence recovered — read the section)`)
      continue
    }
    lines.push(`- **${cost}.** ${paragraph}`)
  }

  const block = [
    '<!-- generated from reference/pjsr-gotchas.md — do not hand-edit this block; edit the gotchas -->',
    '',
    '## Read this before the first `pi-tool` call',
    '',
    'This block ships at the top of the skill, so it is in front of you whether or not you',
    'opened anything else. It lists the traps that have already destroyed a run on this',
    'machine, condensed from `reference/pjsr-gotchas.md`. The full file is the',
    'specification; this is the part you cannot afford to skip.',
    '',
    ...lines,
    '',
    '### Two rules that outrank everything below',
    '',
    '1. **Read `reference/pjsr-gotchas.md` in full before the first command.** This block is a',
    '   reminder, not a substitute — it is deliberately lossy, and the file explains *why* each',
    '   trap exists, which is what lets you recognise a new one.',
    '2. **A trap you discover goes back into `reference/pjsr-gotchas.md` in the same session,',
    '   with the measured numbers.** An unrecorded gotcha is a cost the next run pays again.',
    '',
    'If any `pi-tool` call fails in a way that does not match the arguments you passed, search',
    'the gotchas for that tool name before trying a second workaround.',
    '',
    '---',
    '',
  ].join('\n')

  return { block, missing, empty }
}

/** Content served for a skill: the brief, then the authored body. */
async function contentFor(dir, body) {
  let gotchas
  try {
    gotchas = await readFile(gotchasUrl(dir), 'utf8')
  } catch (error) {
    console.warn(
      `[dsh-pixinsight-pipeline] gotchas brief unavailable for "${dir}", serving the skill without it: ${error?.message ?? error}`,
    )
    return body
  }
  const { block, missing, empty } = buildBrief(gotchas)
  if (missing.length > 0) {
    console.warn(
      `[dsh-pixinsight-pipeline] gotchas brief is stale — section(s) not found in reference/pjsr-gotchas.md: ${missing.join(' | ')}`,
    )
  }
  if (empty.length > 0) {
    console.warn(
      `[dsh-pixinsight-pipeline] gotchas brief has no summary sentence for: ${empty.join(' | ')}`,
    )
  }
  return `${block}${body}`
}

async function readSkill(dir, rank) {
  const locator = skillFileUrl(dir)
  const text = await readFile(locator, 'utf8')
  const { data, body } = parseFrontmatter(text)
  const description = (data.description ?? '').trim()
  // The catalog line is `- \`name\`: <description>`; a one- or two-char value (a stray
  // `|` from a mis-parsed block scalar, a dash, a quote) tells a reader nothing and
  // suppresses the "task clearly matches this skill" routing decision. Refuse it.
  if (description.length < 20) {
    console.warn(
      `[dsh-pixinsight-pipeline] skill "${dir}" has an unusable description (${JSON.stringify(
        description,
      )}); routing would never select it. Fix the frontmatter in skills/${dir}/SKILL.md.`,
    )
  }
  return {
    name: data.name || dir,
    description: description || `Bundled skill ${dir}`,
    ...(data.whenToUse ? { whenToUse: data.whenToUse } : {}),
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank,
    resourceBase: skillResourceBase(dir),
    locator,
    body,
  }
}

const provider = {
  name: PROVIDER_NAME,
  async list() {
    const rank = await resolveRank()
    const out = []
    for (const dir of SKILL_DIRS) {
      try {
        const { body, ...candidate } = await readSkill(dir, rank)
        out.push(candidate)
      } catch (error) {
        // A missing or unreadable skill must not take the host down.
        console.warn(`[dsh-pixinsight-pipeline] cannot list skill "${dir}": ${error?.message ?? error}`)
      }
    }
    return out
  },
  async get(candidate) {
    if (!(candidate?.locator instanceof URL)) {
      throw new Error('dsh-pixinsight-pipeline skill locator must be a URL')
    }
    const text = await readFile(candidate.locator, 'utf8')
    const { body } = parseFrontmatter(text)
    const { body: _ignored, ...meta } = candidate
    const dir = dirForLocator(candidate.locator, candidate.name)
    return { ...meta, content: await contentFor(dir, body) }
  },
}

/** Match a locator back to a shipped skill directory so the brief resolves. */
function dirForLocator(locator, fallbackName) {
  for (const dir of SKILL_DIRS) {
    try {
      if (locator.href === skillFileUrl(dir).href) return dir
    } catch {
      // Not a matching URL — keep looking.
    }
  }
  return SKILL_DIRS.includes(fallbackName) ? fallbackName : SKILL_DIRS[0]
}

export function apply(ctx) {
  try {
    ctx.skills.registerProvider(() => provider)
  } catch (error) {
    console.warn(`[dsh-pixinsight-pipeline] skill provider registration failed: ${error?.message ?? error}`)
  }
}

/** Exported for contract tests / tooling. */
export const __provider = provider
export const __packageRoot = PACKAGE_ROOT
export const __briefSections = BRIEF_SECTIONS

export default { name, inject, apply }
