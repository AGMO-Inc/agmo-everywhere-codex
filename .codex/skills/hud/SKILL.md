---
name: "hud"
description: "Show the current Agmo HUD surfaces: Codex status line and team HUD"
role: "display"
scope: ".agmo/**"
---

# HUD Skill

Agmo currently has **two HUD/status surfaces**:

1. **Codex built-in status line** — the normal TUI footer configured in `~/.codex/config.toml`
2. **Team HUD** — the team-oriented view exposed through `agmo team ...`

There is **no top-level `agmo hud` command** in current CLI help.

## Current commands

```bash
agmo team start <workers> "<task>" --hud
agmo team start <workers> "<task>" --hud --hud-refresh-ms 1000
agmo team start <workers> "<task>" --hud --hud-no-clear
agmo team hud <team>
agmo team hud <team> --watch
agmo team hud <team> --watch --refresh-ms 1000
agmo team hud <team> --stale-ms 120000 --dead-ms 300000
```

Use `--hud` at team start when you want the live team HUD pane immediately. Use `agmo team hud <team>` when the team already exists and you want a current snapshot or watch mode.

## Codex built-in status line

This is separate from Agmo team HUD and remains the default always-on status surface.

Example:

```toml
[tui]
status_line = ["model-with-reasoning", "git-branch", "context-remaining"]
```

## Team HUD scope

`agmo team hud <team>` is team-specific. It is useful for:
- worker health / heartbeat visibility
- stale or dead worker detection
- current task-state overview during a running team session

Treat it as a monitoring view for `agmo team`, not as a global Agmo dashboard.

## Guidance

- If the user asks for a HUD in a normal solo session, point them first to the Codex built-in status line.
- If the user asks for a HUD for coordinated workers, use `agmo team start ... --hud` or `agmo team hud <team>`.
- Do not claim `agmo hud` exists unless the CLI adds it in the future.
