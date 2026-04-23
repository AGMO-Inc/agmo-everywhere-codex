---
name: cancel
description: "[Legacy/compat] Explain current Agmo shutdown flows and legacy OMX cancellation surfaces"
---

# Cancel Skill

This is a **compatibility note**, not a promise of a current Agmo CLI command.

There is **no top-level `agmo cancel` command** in current CLI help.

## Current Agmo approach

In Agmo, cancellation is usually an **explicit shutdown or cleanup action** for the specific runtime you are using.

Use the concrete command that matches the situation:

- active team runtime → `agmo team shutdown <team-name>`
- stale/dead team runtime cleanup → `agmo team cleanup-stale ...`
- lingering legacy `.omx` artifacts → `agmo setup migrate-legacy --scope user|project` (optionally `--delete` after review)

Do not invent or imply a synthetic one-size-fits-all `agmo cancel` command.

## Legacy OMX compatibility

Older OMX docs sometimes referred to `/cancel` or operator-heavy mode cancellation. Treat that as **historical legacy runtime guidance**, not current Agmo CLI behavior.

If the workspace is still using legacy `.omx` runtime artifacts, say that explicitly and use migration/cleanup language rather than claiming a modern Agmo cancel surface exists.

## Assistant rule

When the user says “cancel” or “stop,” first identify which of these they mean:
1. shut down an Agmo team
2. clean up stale Agmo team state
3. migrate/remove leftover legacy OMX runtime state

Then run or recommend the matching explicit command and report exactly what was stopped or cleaned.
