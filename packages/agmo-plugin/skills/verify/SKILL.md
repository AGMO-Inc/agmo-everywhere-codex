---
name: verify
description: Use when the task needs validation, testing, completion checks, or evidence review.
---

# Agmo Verify

Use this when the main goal is proving completion rather than doing first-pass implementation.

## Main behavior

1. choose what must be proven
2. delegate the proof/test lane to `agmo-verifier`
3. separate evidence from assumptions
4. return a concise pass/fail verdict plus gaps
