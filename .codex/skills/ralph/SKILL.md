---
name: ralph
description: Use as an explicit compatibility alias for execute when the user wants completion-gated implementation that keeps going until proof is gathered.
argument-hint: "[task, implementation handoff, or completion-gated execution request]"
---

# Agmo Ralph

Treat this as a compatibility alias of `execute`, not as a separate canonical workflow stage.

## Main behavior

1. route to the `execute` workflow semantics
2. raise the execution bar: do not claim completion without fresh verification evidence
3. if verification fails or returns incomplete proof, fix the issue and re-run the proof loop
4. keep the leader in orchestrator mode while `agmo-executor` handles coding and `agmo-verifier` provides the completion gate verdict
5. escalate to `team` only when implementation and verification truly need durable parallel lanes

## Completion-gated posture

`ralph` means:

- do not stop at first implementation
- distinguish failure from missing proof
- continue through safe, reversible next steps automatically
- report a blocker only when the next move materially depends on user input, missing authority, or unavailable infrastructure

## What it should not become

- not a new public workflow stage
- not a mandatory architect-signoff mode for every small task
- not a replacement for `team` when durable worker lanes are genuinely needed

## Canonical name

Use `execute` in docs, onboarding, and workflow descriptions. Keep `ralph` available so users can explicitly ask for a completion-gated execution pass and existing OMX habits keep routing correctly.
