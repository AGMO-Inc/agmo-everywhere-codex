---
name: plan-review
description: Use when a plan should be challenged, approved, or refined before implementation starts, with agmo-critic/agmo-architect/verifier routing as needed.
argument-hint: "[current plan, plan note, or review request]"
---

# Agmo Plan Review

Use this when the current plan should be challenged, validated, or refined before execution.

## Main-session contract

The main session must not self-approve its own plan.

When `$plan-review` is invoked, the main session should:

1. keep the active workflow in the planning lane
2. gather missing repo facts with `agmo-explore` before judging plan assumptions tied to current files or symbols
3. hand the review pass to the right lane instead of improvising approval in place
   - default challenge lane: `agmo-critic`
   - boundary and tradeoff review: `agmo-architect`
   - acceptance criteria / verification review: `agmo-verifier`
   - revision support when needed: `agmo-planner`
4. return a clear verdict: approve, revise, or reject/re-plan

## Review targets

Check the plan for:

- vague or untestable acceptance criteria
- missing file ownership or execution boundaries
- hidden dependency order
- assumptions that need repo evidence
- unresolved non-goals or decision boundaries
- weak verification shape
- task chunks that are still too large

## Important behavior

- keep this as a plan-stage review, not a generic execution verification pass
- combine reviewer lanes only when they answer different questions
- keep durable context anchored to the plan lane so execution can continue from the same artifact

## Handoff

- if approved, the next likely step is `execute`
- if revisions are needed, return to `plan`
- if the review exposes deeper uncertainty, go back to `brainstorming`
