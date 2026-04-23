---
name: ralplan
description: Use as an explicit compatibility alias for consensus-oriented planning when the user wants a higher-trust plan before execution.
---

# Agmo Ralplan

Treat this as a compatibility alias of `plan`, not as a separate canonical workflow stage.

## Main behavior

1. route to the `plan` workflow semantics
2. raise the planning bar: include assumptions, non-goals, risks, and verification path
3. use `agmo-explore` for repo facts before debating internals the codebase can answer
4. pull in `agmo-architect` for boundary/tradeoff tension and `agmo-critic` when the plan needs a stronger challenge pass
5. end with an execution-ready consensus-style handoff, usually into `plan-review` or `execute`

## Canonical name

Use `plan` in docs, onboarding, and workflow descriptions. Keep `ralplan` available so users can explicitly ask for a consensus-style planning pass and existing OMX habits keep routing correctly.
