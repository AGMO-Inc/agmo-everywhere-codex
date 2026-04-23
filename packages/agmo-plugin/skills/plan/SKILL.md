---
name: plan
description: Use when the task needs scoped planning, decomposition, or execution sequencing before implementation begins, with agmo-explore/agmo-architect support when needed.
argument-hint: "[task, approved design, or planning request]"
---

# Agmo Plan

Use this when the request is too broad, risky, or multi-stage to implement safely without a plan.

## Main-session contract

The main session stays in the planning lane and delegates the main planning synthesis to `agmo-planner`.

When `$plan` is invoked, the main session should:

1. restate the goal, scope, and known non-goals briefly
2. gather repo facts with `agmo-explore` before asking the user about current files, symbols, or patterns
3. pull in `agmo-architect` when the plan depends on boundary, interface, or tradeoff decisions
4. break the work into ordered, testable steps sized to the actual task
5. define verification shape up front instead of leaving proof to the end
6. end with the next concrete handoff, usually `plan-review` or `execute`

## Use this for

- multi-file or multi-stage work
- vague implementation requests
- execution handoff planning
- tasks likely to escalate to `team`
- plans that need explicit acceptance criteria and risk handling

## Do not use this for

- already-clear small implementation tasks
- generic factual Q&A
- first-pass design exploration that still belongs in `brainstorming`

## Planning quality bar

A strong plan should usually include:

1. requirements summary
2. acceptance criteria that are directly testable
3. implementation steps with likely file or ownership hints when known
4. risks and mitigations
5. verification steps
6. the likely next workflow transition

## Interview posture

If the request is still underspecified after repo inspection, ask one focused question at a time. Prefer scope, non-goals, and decision-boundary questions over broad open-ended interrogation.

## Compatibility alias

`ralplan` remains available as a compatibility alias for users who want a higher-trust, consensus-style version of this same planning lane. The canonical workflow name is still `plan`.
