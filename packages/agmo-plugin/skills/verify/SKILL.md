---
name: verify
description: Use when the task needs validation, testing, completion checks, or evidence review.
argument-hint: "[artifact, change, or implementation to verify]"
---

# Agmo Verify

Use this when the primary goal is validation rather than planning or first-pass implementation.

## Main-session contract

The main session orchestrates verification and delegates the evidence-gathering lane to `agmo-verifier`.

Typical responsibilities:

1. choose what must be proven
2. delegate the proof / test / inspection lane
3. read the actual output instead of trusting summaries alone
4. decide whether to accept completion, request fixes, or escalate back to `execute`

## Use this for

- implementation verification
- test-focused follow-up
- completion evidence review
- non-plan-specific review requests

## Do not use this for

- first-pass plan critique that should stay in the planning lane (`plan-review`)
- open-ended design exploration (`brainstorming`)

## Verdict contract

Return a concise `PASS / FAIL / INCOMPLETE / BLOCKED` verdict plus gaps.

- `FAIL` means the proof shows broken behavior
- `INCOMPLETE` means the proof bar was not fully met yet
- `BLOCKED` means the next verification step cannot proceed without external resolution

Distinguish missing proof from proven failure so `execute` can decide whether to fix, re-run, or report a blocker.
