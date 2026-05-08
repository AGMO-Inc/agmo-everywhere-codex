---
name: ralplan
description: Use as an explicit compatibility alias for consensus-oriented planning when the user wants a higher-trust plan before execution.
argument-hint: "[task, approved design, or consensus planning request]"
---

# Agmo Ralplan

Treat this as a compatibility alias of `plan`, not as a separate canonical workflow stage.

## Main behavior

1. route to the `plan` workflow semantics
2. raise the planning bar by making assumptions, non-goals, risks, and verification path explicit
3. use `agmo-explore` for repo facts before debating internals the codebase can answer
4. pull in `agmo-architect` for boundary and tradeoff review
5. pull in `agmo-critic` when the plan needs a stronger challenge pass before execution
6. end with an execution-ready handoff, usually into `plan-review` or `execute`

## Native subagent lifecycle

When spawning native subagents for this workflow, keep each agent id until its result is integrated, then call `close_agent` for completed, failed, superseded, or no-longer-needed lanes so thread slots are released before the next delegation.

## Expected output shape

A strong `ralplan` result should usually include:

- a concise requirements summary
- decision drivers or main planning principles
- viable options or the invalidation reason for discarded options
- recommended direction
- testable acceptance criteria
- risks, mitigations, and verification path

## Artifact save body

Before ending a meaningful consensus-planning stage, make the final response or delegated result save-ready:

- goal, principles, and decision drivers
- options and chosen direction
- acceptance criteria
- verification path
- risks and execution handoff

## Hard gate

`ralplan` should not auto-start implementation. It is still a planning-lane workflow.

## Canonical name

Use `plan` in docs, onboarding, and workflow descriptions. Keep `ralplan` available so users can explicitly ask for a consensus-style planning pass without introducing a separate workflow stage.
