---
name: team
description: Use when one execution lane is no longer enough and work should escalate to the durable `agmo team ...` runtime.
---

# Agmo Team

Use this when the leader should stay in-session while durable worker lanes handle parallel work.

## Main behavior

1. keep the leader in orchestrator mode
2. use `agmo team start ...` for durable multi-worker execution
3. trust `.agmo/state/team/...` over tmux UI alone
4. monitor with `agmo team status`, `agmo team monitor`, and `agmo team hud`
5. shut down explicitly with `agmo team shutdown <team>`

## Use this for

- independent implementation / verification lanes
- long-running coordinated work
- worktree-backed execution and later integration
