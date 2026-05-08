---
name: wisdom
description: Use when prior notes, durable project knowledge, or vault-backed context should influence the current task.
argument-hint: "[knowledge question, doc task, or note synthesis ask]"
---

# Agmo Wisdom

Use this when durable knowledge should shape the current run.

## Main-session contract

The main session should delegate this workflow to `agmo-wisdom`, then integrate the result back into the active workflow.

After the delegated result is integrated, call `close_agent` for the `agmo-wisdom` lane so the completed native subagent session releases its thread slot.

Use it for:

- doc or knowledge synthesis
- note consolidation
- research summaries grounded in durable project context
- save-ready note preparation when persistence is likely

## Recommended output modes

Prefer one of these explicit shapes instead of a loose freeform answer:

- `retrieve` — find the best prior note candidates
- `synthesize` — summarize or compare durable context
- `prepare-save` — shape the result so it can become a durable note

## Durable-knowledge contract

A good wisdom result should usually include:

- a short answer first
- evidence vs inference when interpretation is involved
- cited note candidates or knowledge sources with why they matter
- inferred project / design / plan lineage when relevant
- a recommended durable title if the result should be saved
- recommended aliases, tags, parent, and related links when persistence is likely

## Artifact save body

Before ending a meaningful wisdom stage, make the final response or delegated result save-ready:

- knowledge question or durable decision
- evidence vs inference
- canonical note target and duplicate handling
- recommended note update or follow-up handoff

## Canonical-note behavior

If multiple note candidates overlap heavily:

1. identify the strongest canonical note
2. explain why the others are weaker, duplicate-like, or draft-like
3. recommend extending the canonical note instead of creating another near-duplicate unless the artifact is materially distinct
