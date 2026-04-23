---
name: plan-review
description: Use when a plan should be challenged, approved, or refined before implementation starts, with agmo-critic/agmo-architect/verifier routing as needed.
---

# Agmo Plan Review

Use this when the current plan should be reviewed without jumping into coding.

## Main behavior

1. keep the work in the planning lane
2. gather missing repo facts with `agmo-explore` before judging plan assumptions tied to current files or symbols
3. use `agmo-critic` as the default challenge lane
4. add `agmo-architect` when the review depends on boundaries, interfaces, or tradeoffs
5. use `agmo-verifier` when acceptance criteria, verification shape, or evidence quality is the core question
6. return one verdict: approve, revise, or reject
