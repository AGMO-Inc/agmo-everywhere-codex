---
name: help
description: "Guide on using Agmo workflows, setup, and compatibility aliases"
---

# How Agmo Works

Plain English works as best-effort guidance — Agmo inspects each prompt and may add advisory routing context to steer the model toward a suitable lane. This is **advisory prompt-routing context**: it does not activate a skill or workflow by itself. Explicit keywords remain the deterministic control surface when you want exact, guaranteed routing.

## Recommended public workflow

Agmo's preferred public workflow surface is:

`brainstorming -> plan -> plan-review -> execute -> team`

Use the leftmost skill that matches where you are:

| Skill | Use it when |
|-------|-------------|
| `brainstorming` | shaping ideas, tradeoffs, or direction |
| `plan` | turning intent into an execution-ready handoff |
| `plan-review` | challenging or approving a plan before coding |
| `execute` | coding should start from an approved plan in the current session |
| `team` | execution now needs durable tmux workers / coordinated lanes |
| `verify` | you need proof, tests, or completion review |
| `wisdom` | you need durable knowledge, notes, or vault-backed context |

`design` remains available only as a compatibility alias that routes into `brainstorming`; it is not a separate public workflow stage.

## What Happens Automatically

| When You... | Agmo Usually... |
|-------------|-----------------|
| ask for ideas or tradeoffs | routes toward `brainstorming` |
| ask to plan something | routes toward `plan` or `plan-review` |
| ask to build or fix something | routes toward `execute` |
| need durable parallel execution | escalates toward `team` |
| say "stop" or "cancel" | figures out what to stop from context |

**Triage lanes** (when no keyword matches): read-only lookups receive agmo-explore guidance; implementation work receives executor guidance; UI work may receive designer guidance; simple conversational prompts receive no injection (PASS). To opt out per prompt, include a phrase such as `no workflow`, `just chat`, or `plain answer`.

## Recommended shortcuts

You can include these keywords naturally in your request for explicit control:

| Keyword | Effect | Example |
|---------|--------|---------|
| **brainstorming** | early ideation / direction shaping | "brainstorming the vault UX" |
| **design** | alias for `brainstorming` | "design the settings flow" |
| **plan** | execution-ready planning lane | "plan the new endpoints" |
| **plan-review** | review an existing plan | "plan-review this rollout" |
| **execute** | start coding in the current session | "execute the CLI cleanup" |
| **team** | escalate to durable tmux workers | "team this after plan approval" |
| **verify** | run tests / evidence review | "verify the setup flow" |
| **wisdom** | retrieve or persist durable knowledge | "wisdom: summarize prior notes" |

## Stopping Things

Just say:
- "stop"
- "cancel"
- "abort"

Agmo will infer what to stop from context.

## First Time Setup

If you haven't configured Agmo yet:

```
agmo setup
```

This is the main setup command.

If you only need project-scoped setup in the current repo, use:

```bash
agmo setup --scope project
```

## Legacy compatibility

Older OMX-oriented shortcuts may still exist in some environments, but they are not the primary teaching surface here. If you're onboarding someone new, teach:

`brainstorming -> plan -> plan-review -> execute -> team`
