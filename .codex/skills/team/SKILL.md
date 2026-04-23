---
name: team
description: Use when one execution lane is no longer enough and work should escalate to the durable `agmo team ...` runtime.
argument-hint: "[task, worker split, or team-runtime request]"
---

# Agmo Team

Use `agmo team ...` when lightweight in-session help is not enough and you need a durable multi-worker runtime.

## Core posture

- the leader stays in the current session as orchestrator
- durable state under `.agmo/state/team/<team>/...` is the control plane
- tmux panes are worker transport and UI, not the source of truth
- native subagents are still better for small bounded sidecars

## When to use `agmo team`

Escalate to team mode when you need one or more of:

- multiple independent implementation / verification / planning / knowledge lanes
- durable monitoring beyond one reasoning burst
- shared task claiming, worker heartbeat, or worktree-backed execution
- separate implementation and verification lanes for completion-gated execution (`ralph` / strict `execute`)

For small same-session sidecars, prefer native subagents instead.

## Leader responsibilities

The leader should:

1. keep the task brief current and scoped
2. start the team with `agmo team start ...`
3. verify startup with `agmo team status <team>`
4. monitor with `agmo team status`, `agmo team monitor`, and `agmo team hud`
5. prefer reclaim/rebalance/cleanup over ad hoc worker intervention when lanes stall
6. own final integration, verification, and completion reporting

## Runtime artifacts to trust

Useful runtime artifacts live under `.agmo/state/team/<team>/`, including config, phase, tasks, worker status, heartbeat, inbox, mailbox, and dispatch state.

If tmux UI and durable state disagree, trust the durable state first.

## Lifecycle

1. start the team with a scoped task
2. monitor progress from runtime state, not guesswork alone
3. integrate and verify once worker lanes report completion
4. shut down explicitly with `agmo team shutdown <team>` when the work is done or aborted
