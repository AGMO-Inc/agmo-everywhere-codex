---
name: plan-review
description: "Agmo plan critique workflow. Use to review or challenge a plan via agmo-critic/agmo-architect/verifier lanes while keeping the work in the planning lane."
argument-hint: "[current plan, plan note, or review request]"
---

# Plan Review

Use this when the user wants the current plan challenged, validated, or refined before execution.

## Main-session contract

The main session is the orchestrator and **must not self-approve its own plan**.

When `$plan-review` is invoked, the main session should:

1. Keep the active workflow in the **planning** lane
2. Gather missing repo facts with `agmo-explore` before approving or rejecting plan assumptions tied to current files, symbols, or patterns
3. Hand the review pass to the right reviewer lane rather than improvising approval in-place
   - default challenge lane: `agmo-critic`
   - architectural boundaries / interfaces / tradeoffs: `agmo-architect`
   - acceptance criteria / verification shape / evidence quality: `agmo-verifier`
   - optional support: `agmo-planner` for incorporating accepted revisions after critique
4. Return a clear verdict:
   - approve
   - revise
   - reject / re-plan

## Review targets

Check the plan for:

- missing or vague acceptance criteria
- weak file ownership / execution boundaries
- hidden dependency order
- assumptions that need repo evidence before approval
- non-goals / decision boundaries that are still unresolved
- verification gaps
- oversized tasks that should be decomposed further

## Important behavior

- Treat this as a **plan-stage review**, not a generic memo-only verification pass
- Treat `agmo-critic`, `agmo-architect`, and `agmo-verifier` as peer review lanes; combine them only when they answer different questions
- Keep the durable context anchored to the plan lane so execution can continue from the same artifact
- If the review surfaces only small corrections, update the plan and stay in `$plan`
- If the review surfaces major uncertainty, escalate back to `$brainstorming` or `$deep-interview`

## Handoff

After review:

- if approved, the next likely step is `$execute`
- if revisions are needed, return to `$plan`
