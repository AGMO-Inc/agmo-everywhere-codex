---
name: verify
description: "Agmo verification workflow. Use for tests, evidence gathering, completion review, and non-plan-specific validation."
argument-hint: "[artifact, change, or implementation to verify]"
---

# Verify

Use this when the primary goal is validation rather than planning or initial implementation.

## Main-session contract

The main session orchestrates verification and delegates the evidence-gathering lane to `agmo-verifier`.

Typical responsibilities:

1. choose what must be proven
2. delegate the proof / test / inspection work
3. read the actual output
4. decide whether to:
   - accept completion
   - request fixes
   - escalate back to `$execute`

## Use this for

- implementation verification
- test-focused follow-up
- completion evidence review
- non-plan-specific review requests

## Do not use this for

- first-pass plan critique that should stay in the planning lane (`$plan-review`)
- open-ended design exploration (`$brainstorming`)
