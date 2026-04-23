---
name: execute
description: Use when implementation should begin from an approved plan, with agmo-explore/agmo-architect preflight and the main session staying in orchestrator mode while handing coding to the Agmo execution lane.
---

# Agmo Execute

Use this when the task should move from an approved plan into implementation.

## Main behavior

The main session should:

1. confirm the accepted scope and non-goals
2. use `agmo-explore` first when file ownership, symbols, or current patterns are unclear
3. route unresolved boundary or tradeoff questions to `agmo-architect`
4. hand the primary coding lane to `agmo-executor`
5. keep integration and scope control in the leader
6. pull `agmo-verifier` for proof before claiming completion
7. if proof fails or remains incomplete, keep the fix -> re-verify loop running until the task passes or a real blocker is identified

## Expectations

- keep changes incremental
- verify before reporting done
- escalate to `team` only when one execution lane is not enough

## Compatibility alias

`ralph` remains available as a compatibility alias for users who want a stricter completion gate on top of `execute` semantics. The canonical workflow name is still `execute`.
