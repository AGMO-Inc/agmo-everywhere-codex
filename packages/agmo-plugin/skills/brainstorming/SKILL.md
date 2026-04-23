---
name: brainstorming
description: Use as the canonical first-stage Agmo workflow when the user wants idea exploration, design tradeoffs, or requirement shaping before planning or implementation.
argument-hint: "[idea, design problem, or feature direction]"
---

# Agmo Brainstorming

Use this when the direction is still fluid and implementation should stay blocked.

`brainstorming` is the canonical first-stage workflow name. Requests phrased as `design` should route into this same lane as compatibility behavior, not as a separate workflow stage.

## Main-session contract

The main session is the orchestrator. Do not become the primary implementation worker here.

When `$brainstorming` is invoked, the main session should:

1. gather brownfield context first from the repo and durable notes before asking the user questions the codebase can answer
2. delegate the primary exploration pass to `agmo-planner`
3. use `agmo-explore` for fast repo facts and `agmo-architect` when the design tension is really about boundaries or tradeoffs
4. bring the delegated result back into a user-facing design conversation
5. keep implementation blocked until the direction is explicitly accepted

## Questioning style

Keep the interaction lighter than a full interview, but do not stay shallow.

Prefer one focused question at a time, in roughly this order:

1. intent — why this matters
2. outcome — what good looks like
3. scope — what should change
4. non-goals — what must stay out of scope
5. decision boundaries — what the agent may decide vs what still needs approval
6. constraints — technical, product, or business limits

Before asking about internals, inspect the repo first and ask evidence-backed questions.

## Design output shape

By the end of the brainstorming pass, try to provide:

1. 2-3 viable approaches with tradeoffs
2. a recommended direction
3. the main risks or tensions
4. the next likely workflow transition

## Hard gates

- do not start implementation from this skill
- do not jump to `$team` unless the user is explicitly asking for execution and the design is already settled
- if the direction is accepted, the normal next step is `$plan`

## Durability

Prefer citing the files, patterns, or prior notes that informed the recommendation so the approved design can become durable context for later planning and execution.
