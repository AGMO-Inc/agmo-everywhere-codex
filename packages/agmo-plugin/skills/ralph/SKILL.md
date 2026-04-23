---
name: ralph
description: Use as an explicit compatibility alias for execute when the user wants completion-gated implementation that keeps going until proof is gathered.
---

# Agmo Ralph

Treat this as a compatibility alias of `execute`, not as a separate canonical workflow stage.

## Main behavior

1. route to the `execute` workflow semantics
2. raise the execution bar: do not claim completion without fresh verification evidence
3. if verification fails or returns incomplete proof, fix the issue and re-run the proof loop
4. keep the leader in orchestrator mode while `agmo-executor` handles coding and `agmo-verifier` provides the completion gate verdict
5. escalate to `team` only when implementation and verification need durable parallel lanes

## Canonical name

Use `execute` in docs, onboarding, and workflow descriptions. Keep `ralph` available so users can explicitly ask for a completion-gated execution pass and existing OMX habits keep routing correctly.
