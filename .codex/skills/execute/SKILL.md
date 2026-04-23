---
name: execute
description: "Agmo implementation orchestration workflow. Use when approved plan work is ready and coding should begin, with agmo-explore/agmo-architect preflight and the main session staying as orchestrator."
argument-hint: "[approved plan, implementation request, or execution handoff]"
---

# Execute

Use this when implementation should begin.

## Main-session contract

The main session remains the orchestrator. Do not absorb the whole execution lane into the leader by default.

When `$execute` is invoked, the main session should:

1. Confirm the latest accepted context
   - approved plan (with any linked design context)
   - non-goals / constraints
   - verification expectations
2. Fill missing repo facts with `agmo-explore` before coding when file locations, current patterns, or symbol ownership are unclear
3. Route unresolved boundaries, interfaces, or tradeoff questions to `agmo-architect` before or alongside implementation when needed
4. Delegate the primary coding lane to `agmo-executor`
5. Pull in `agmo-verifier` for evidence, tests, or completion review when needed
6. Keep ownership of:
   - scope control
   - integration decisions
   - workflow transitions
   - durable note continuity

## Default posture

- Start with **solo delegated execution**
- Prefer `agmo-explore` over ad hoc guessing for quick repo lookups during execution
- Use native subagents for bounded sidecars when they do not require durable team coordination
- Escalate to `$team` only when the work has genuinely independent parallel lanes or needs durable pane-based workers

## When to escalate to `$team`

Escalate when at least one of these is true:

- API / UI / test work can proceed independently
- implementation is large enough that one executor lane becomes the bottleneck
- you need durable tmux workers with observable progress

When escalating, the leader should stay in orchestrator mode and treat `$team` as the worker runtime, not as a replacement for the leader.

## Execution expectations

- ground the implementation in the approved plan/design
- treat direct brainstorming-to-execute jumps as exceptional rather than the default public path
- keep changes incremental and reversible
- verify with concrete evidence before claiming completion
- capture changed files, verification output, and resulting decisions as durable context

## Output

By the end of the workflow, the leader should be able to report:

- what changed
- what was verified
- what remains / risks

Agmo autosave is expected to persist implementation checkpoints in the implementation note lane.
