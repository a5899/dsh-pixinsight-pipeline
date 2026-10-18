# First run — working directory

This skill writes files as it processes: step previews, saved variants (image
snapshots), and run bookkeeping. They all live under **one** workspace root, and
the root is chosen once per installation.

## Rules

1. **Ask once, never twice.** The prompt is driven by data, not by a flag file:
   `workspace_show` returns `"first_use": true` when no choice is stored and no
   `PIXINSIGHT_WORKSPACE` override is set. Once `first_use` is `false`, do not
   ask again — including in later sessions.
2. **"Default" is a real answer.** Not choosing is supported: processing simply
   continues in `~/.pixinsight-mcp`. Never block a run because the user did not
   answer.
3. **Never invent a path.** Offer the default plus a suggestion; let the user
   name their own folder. Do not create folders in their Documents tree without
   a yes.
4. **Verify before promising.** `workspace_set` performs a write test and
   creates the subdirectories. If it returns `writable: false`, say so and fall
   back to the default.

## Agent script (first run)

```text
1. node pi-tool.mjs workspace_show '{}'
2. If first_use is false  -> continue, no question.
   If first_use is true   -> ask exactly one question:

   "This is the first time the PixInsight pipeline runs here. Where should it
    keep previews and intermediate files?
      [1] Default: <default_workspace>   (recommended)
      [2] Somewhere else: give me a folder path"

3. [1] or no answer  -> node pi-tool.mjs workspace_set '{"path":"default"}'
   [2]              -> node pi-tool.mjs workspace_set '{"path":"<their path>"}'
4. Report the chosen path once, then start the normal Flow A/B/C work.
```

The `workspace_show` payload already contains a ready-made `prompt` field with
the same wording — quote it rather than paraphrasing it into something longer.

## What lands where

| Subfolder | Contents | Written by |
|---|---|---|
| `<root>/previews` | STF-stretched JPEGs, one per stage | `save_preview` |
| `<root>/variants` | XISF snapshots + JSON metadata | `save_variant` / `load_variant` |
| `<root>/runs` | run logs and bookkeeping | future run tooling |

Final deliverables (the 16-bit XISF master and the JPG preview) are **not**
workspace files: save them where the user wants the finished picture, and put
the recipe next to them.

## Changing your mind later

```text
workspace_set {"path":"D:\\astro\\work"}   # switch, e.g. per project
workspace_set {"path":"default"}           # forget the choice; back to ~/.pixinsight-mcp
```

Existing files are not moved when the workspace changes. Point the new
workspace at a fresh folder per target if you want per-object separation, e.g.
`D:\astro\M45\work` for one image.

## Environment override (no file written)

```powershell
$env:PIXINSIGHT_WORKSPACE = 'D:\scratch\pi'
node pi-tool.mjs workspace_show '{}'
```

Precedence: `PIXINSIGHT_WORKSPACE` → `~/.pixinsight-mcp/workspace.json` →
default `~/.pixinsight-mcp`.

## Reset

Deleting `~/.pixinsight-mcp/workspace.json` makes the next run a first run
again. The workspace itself is untouched — deleting the config never deletes
anyone's images.
