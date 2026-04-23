---
name: execute
description: Use when implementation should begin from an approved plan, with agmo-explore/agmo-architect preflight and the main session staying in orchestrator mode while handing coding to the Agmo execution lane.
argument-hint: "[approved plan, implementation request, or execution handoff]"
---

# Agmo Execute

Use this when implementation should begin from an approved plan or otherwise accepted scope.

## Main-session contract

The main session remains the orchestrator. Do not absorb the full execution lane into the leader by default.

When `$execute` is invoked, the main session should:

1. confirm the accepted scope, constraints, and non-goals
2. fill missing repo facts with `agmo-explore` before coding when file ownership, patterns, or symbol locations are unclear
3. route unresolved boundary or tradeoff tension to `agmo-architect`
4. delegate the primary coding lane to `agmo-executor`
5. keep integration, scope control, and workflow transitions in the leader
6. pull `agmo-verifier` for proof before claiming completion
7. if proof fails or remains incomplete, keep the fix -> re-verify loop running until the task passes or a real blocker is identified

## Default posture

- start with solo delegated execution
- keep changes incremental and reversible
- prefer repo evidence over guesses during implementation
- escalate to `team` only when one execution lane is no longer enough

## Completion gate

A task is not done just because code was written.

Before reporting completion, expect:

- concrete implementation evidence
- fresh verification output
- a clear distinction between failures, missing proof, and true blockers

## Output expectation

By the end of the workflow, the leader should be able to report:

- what changed
- what was verified
- what remains or still risks follow-up

## Compatibility alias

`ralph` remains available as a compatibility alias for users who want a stricter completion gate on top of `execute` semantics. The canonical workflow name is still `execute`.
