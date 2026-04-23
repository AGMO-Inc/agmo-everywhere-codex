---
name: plan
description: Use when the task needs scoped planning, decomposition, or execution sequencing before implementation begins, with agmo-explore/agmo-architect support when needed.
---

# Agmo Plan

Use this when the request is too broad to implement safely without a plan.

## Main behavior

The main session should:

1. restate the goal briefly
2. gather repo facts with `agmo-explore` before asking for internals that the codebase can answer
3. break the work into ordered, testable steps
4. call out risks, non-goals, verification shape, and any boundary/tradeoff questions that may need `agmo-architect`
5. hand planning synthesis to `agmo-planner`
6. end with the next concrete handoff: usually `plan-review` (`agmo-critic`/`agmo-verifier`, with `agmo-architect` when design tension remains) or `execute`

## Use this for

- multi-file or multi-stage work
- vague implementation requests
- execution handoff planning
- work that may later escalate to `team`

## Do not use this for

- already-clear small implementation tasks
- generic factual Q&A
