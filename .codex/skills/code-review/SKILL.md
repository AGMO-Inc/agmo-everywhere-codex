---
name: code-review
description: Run a Codex-native structured code review using agmo-critic and agmo-verifier where evidence is needed.
argument-hint: "[plan path, diff scope, or review request]"
---

# Code Review

Use this skill when the user asks for code review or when an implementation needs a structured review before handoff. The main session stays in orchestration mode and delegates review evidence to existing native roles.

## Scope

1. If a plan is provided, read it and treat its file references, acceptance criteria, non-goals, and QA scenarios as the spec.
2. If no plan is provided, use `git diff --name-only` and `git diff --stat` to identify the review scope.
3. Detect scope drift by comparing changed files against the plan's referenced files. Report unplanned files separately; do not block only because drift exists.

## Review Stages

### Stage 1: Spec Compliance

Delegate plan/spec comparison to `agmo-critic`.

Check whether each planned item was implemented, acceptance criteria are met, and "must not" constraints were respected. If no plan exists, skip this stage and state that review is diff-scoped.

### Stage 2: Code Quality

Delegate quality review to `agmo-critic`.

Review for:

- correctness and edge cases
- security and trust-boundary handling
- data-loss prevention
- performance regressions that are visible from the diff
- consistency with existing repo patterns
- over-engineering as a separate non-blocking axis

For the over-engineering lens, use exactly these tags:

- `delete:` dead or speculative code
- `stdlib:` hand-rolled standard library behavior
- `native:` behavior already supplied by the platform/framework
- `yagni:` abstraction, config, or layer with a single implementation
- `shrink:` same behavior with less code

Format each over-engineering finding as:

```text
<location>: <tag> <what>. <replacement>.
```

End that lens with `net: -N lines possible.` or `Lean already.` Classify these findings as IMPORTANT or MINOR unless they independently create correctness, security, or performance risk.

### Stage 3: Evidence Check

When review claims depend on commands, logs, or tests, delegate concrete proof to `agmo-verifier` or run the relevant verification directly. Do not claim tests passed without fresh output.

## Output

Report:

- overall verdict: `APPROVE` or `REQUEST_CHANGES`
- spec compliance result, or `not applicable`
- scope drift findings from `git diff --name-only`
- CRITICAL, IMPORTANT, and MINOR findings
- over-engineering lens summary
- verification evidence used, or the proof gap if not available

## Constraints

- Read-only. Do not edit code while using this skill.
- Do not introduce legacy agent names, model tiers, command-only invocation assumptions, or scripts.
- Do not treat over-engineering findings as CRITICAL unless the same issue also creates a concrete correctness, security, or performance defect.
