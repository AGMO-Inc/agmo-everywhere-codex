---
name: vault-search
description: "Agmo durable knowledge retrieval workflow. Use to locate relevant Obsidian/vault notes before planning or execution."
argument-hint: "[search topic, note name, or past decision]"
---

# Vault Search

The main session should delegate note lookup and synthesis to `agmo-wisdom`, then bring the result back into the active workflow.

Use this to:

- find prior design / plan / implementation notes
- recover earlier decisions
- link the current task to durable project context

Do not turn this into implementation work; it is a retrieval and synthesis utility.

## Search quality contract

Search is not just filename grep. Prefer the vault signals that make later saving and backlinking work well.

Default retrieval order:

1. current project note family
2. linked parent/related notes
3. neighboring notes with matching aliases or tags
4. broader vault matches only when project-local context is insufficient

Use metadata as evidence:

- `project_note`
- `parent`
- `related`
- `aliases`
- family tags such as `type/...`
- project/workflow tags

When returning results, include:

- the best canonical note candidate first
- nearby alternatives only when they add distinct context
- why each candidate is relevant
- the likely note family to update or extend
- whether a fresh durable note is preferable to mutating an existing one

Avoid promoting weak worker-bootstrap or prompt-dump notes as the primary result unless they are the only available evidence.
