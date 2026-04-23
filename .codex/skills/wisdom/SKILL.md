---
name: wisdom
description: "Agmo knowledge synthesis workflow. Use for research/doc synthesis and durable knowledge operations that should be delegated away from the leader."
argument-hint: "[knowledge question, doc task, or note synthesis ask]"
---

# Wisdom

The main session should delegate this workflow to `agmo-wisdom`.

Use it for:

- doc / knowledge synthesis
- note consolidation
- research summaries grounded in durable project context

The leader owns routing and integration; the delegated lane owns retrieval and synthesis.

## Recommended output modes

Prefer one of these explicit shapes instead of a loose freeform answer:

- **retrieve** — when the main job is finding the best prior note(s)
- **synthesize** — when the main job is summarizing or comparing durable context
- **prepare-save** — when the result is likely to become a durable note

If useful, label the response with the chosen mode.

## Durable-knowledge contract

When `wisdom` is used for note retrieval or note creation support, the delegated lane should not return a vague summary alone. It should return retrieval-ready structure the leader can save or cite directly.

Default deliverable:

- short answer first
- evidence vs inference split when interpretation is involved
- cited note candidates with why each matters
- any inferred project/design/plan lineage
- a recommended durable title if the result should be saved
- recommended aliases, tags, parent, and related links when persistence is likely

## Quality bar for saved knowledge

Ground note preparation in the actual vault patterns:

- avoid raw prompt-text titles
- prefer artifact-centered titles
- preserve project linkage
- preserve upstream/downstream links
- keep summaries compact and searchable

The current `agmo-everywhere-codex` vault shows that autosaved checkpoints can drift into noisy worker-instruction titles. `wisdom` should correct for that by extracting the real artifact topic before handing content back.

## Retrieval and synthesis behavior

When gathering context from the vault:

- start from the current project
- look for the nearest matching note family first: design, plan, implementation, research, memo
- prefer notes with clear titles and explicit links over weak prompt-dump matches
- use aliases, tags, `project_note`, `parent`, and `related` as evidence, not just filename keyword overlap
- if multiple notes are near-duplicates, call that out and recommend the canonical one

## Persistence handoff behavior

If the result should become a durable note, hand back:

1. proposed note type
2. proposed title
3. one-sentence rationale for that title
4. summary/body outline
5. aliases to preserve user phrasing or prior naming
6. tags for topic plus workflow family
7. parent and related links

Do not dump raw transcripts into a note unless the transcript itself is the artifact being saved.

## Canonical-note rule

If multiple candidates overlap heavily:

- identify the strongest canonical note
- explain why the others are weaker, duplicate, or draft-like
- recommend extending the canonical note instead of creating another near-duplicate unless the new artifact is materially distinct
