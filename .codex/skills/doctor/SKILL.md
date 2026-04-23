---
name: doctor
description: "Diagnose Agmo runtime/setup issues and identify legacy OMX artifacts to migrate"
---

# Doctor Skill

Use this skill for **current Agmo runtime diagnostics**.

Prefer the built-in command:

```bash
agmo doctor [--scope user|project]
```

It emits a JSON report for the selected scope and checks:
- Agmo-managed runtime files under `.codex/` and `.agmo/`
- `AGENTS.md` presence/management status
- vault configuration and existence
- tmux availability for `agmo team`
- launch workspace cache health
- legacy `.omx` runtime artifacts in project and user scope

## Recommended workflow

1. Run `agmo doctor --scope project` in a repo, or `agmo doctor --scope user` for the user install.
2. Read the actual warnings/info instead of assuming every missing optional feature is fatal.
3. If legacy `.omx` artifacts are reported, migrate them with:

```bash
agmo setup migrate-legacy --scope project
agmo setup migrate-legacy --scope user
```

Add `--delete` only after reviewing the migrated output and intentionally removing the legacy source files.

4. If core runtime files are incomplete, rerun setup for that scope:

```bash
agmo setup --scope project
agmo setup --scope user
```

Use `--force` only when you intentionally want Agmo to adopt or rewrite managed files.

## What this skill should not lead with

Do **not** treat older oh-my-codex troubleshooting steps as the primary path for current Agmo installs. In particular, avoid leading with:
- plugin-cache version checks
- manual hook-script deletion under `~/.codex/hooks/`
- `settings.json` hook surgery

Those are historical/manual investigations for pre-Agmo or partially migrated installs only.

## Report shape

When summarizing doctor output, keep it short and actionable:
- **Summary** — healthy / warnings found
- **Evidence** — exact checks that failed or warned
- **Recommended next command** — usually `agmo setup ...` or `agmo setup migrate-legacy ...`
- **Risk note** — especially before using `--delete`
