---
name: team
description: "Agmo durable multi-worker runtime using `agmo team ...` with leader-orchestrated state under `.agmo/state/team/`"
---

# Team Skill

Use `agmo team ...` when lightweight in-session help is not enough and you need a **durable multi-worker runtime**.

Current Agmo posture:
- the **leader stays in the current session** as orchestrator
- the durable control plane lives under `.agmo/state/team/<team>/...`
- tmux panes are the worker transport/UI, not the source of truth
- native subagents are still better for small bounded sidecars

## When to use `agmo team`

Escalate to team mode when you need one or more of:
- multiple independent implementation/verification/planning/knowledge lanes
- shared task claiming and worker heartbeats
- durable monitoring beyond one reasoning burst
- worktree-backed worker execution and later integration help

For small same-session sidecars, prefer native subagents instead.

## Start command

```bash
agmo team start <workers> "<task>" \
  [--name <team-name>] \
  [--allocation-intent implementation|verification|planning|knowledge] \
  [--role-map worker-1=agmo-planner,worker-2=agmo-executor,...] \
  [--hud] [--hud-refresh-ms <ms>] [--hud-clear|--hud-no-clear]
```

Examples:

```bash
agmo team start 3 "stabilize the release branch and verify the fix"
agmo team start 2 "review docs and verify CLI help" --allocation-intent verification
agmo team start 3 "split planning, execution, and verification" \
  --role-map worker-1=agmo-planner,worker-2=agmo-executor,worker-3=agmo-verifier \
  --hud
```

## Leader responsibilities

The leader should:
- keep the task brief current and scoped
- monitor runtime state with `agmo team status <team>` and, when useful, `agmo team monitor <team>`
- use `agmo team hud <team>` for a live team-oriented view
- use reclaim/rebalance only when workers stall or drift
- own final integration, verification, and completion reporting

## Current command surface

Common leader/runtime commands:

```bash
agmo team status <team-name>
agmo team shutdown <team-name>
agmo team cleanup-stale [--stale-ms <ms>] [--dead-ms <ms>] [--include-stale|--no-include-stale] [--dry-run|--no-dry-run]
agmo team monitor <team> [...]
agmo team hud <team> [--watch] [--refresh-ms <ms>]
agmo team reclaim <team> [...]
agmo team rebalance <team> [...]
agmo team integrate <team> [...]
agmo team integrate-assist <team> [...]
agmo team dispatch-ack <team> <request-id>
agmo team dispatch-retry <team> [worker]
agmo team alert-delivery show <team>
agmo team alert-delivery set <team> [...]
```

Worker/task-progress commands also exist:

```bash
agmo team send <team> <worker> "<message>"
agmo team claim <team> <task-id> <worker>
agmo team complete <team> <task-id> <worker> [result text]
agmo team fail <team> <task-id> <worker> [error text]
agmo team heartbeat <team> <worker>
agmo team report <team> <worker> <idle|working|done|blocked> [--task <id>] [--note <text>]
```

## Durable state to trust

Useful runtime artifacts live under `.agmo/state/team/<team>/`, including:
- `config.json`
- `manifest.json`
- `phase.json`
- `tasks/task-*.json`
- `workers/worker-*/identity.json`
- `workers/worker-*/status.json`
- `workers/worker-*/heartbeat.json`
- `workers/worker-*/inbox.md`
- `mailbox/`
- `dispatch/`

Workers may also be provisioned under `.agmo/worktrees/<team>/worker-*/`.

## Lifecycle guidance

1. Start the team with a scoped task.
2. Verify it came up with `agmo team status <team>`.
3. Monitor progress using status/monitor/HUD, not tmux guesswork alone.
4. If workers stall, prefer `cleanup-stale`, `reclaim`, or `rebalance` over ad-hoc intervention.
5. Use `agmo team shutdown <team>` when the team is done or the user explicitly wants to abort.

Keep the wording Agmo-first. Avoid older OMX/operator-heavy instructions unless you are explicitly helping someone migrate legacy behavior.
