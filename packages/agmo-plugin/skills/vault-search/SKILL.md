---
name: vault-search
description: Use when the task needs relevant prior notes, vault context, or stored project decisions before planning or execution.
argument-hint: "[search topic, note name, or past decision]"
---

# Agmo Vault Search

Use this before planning or execution when prior durable context matters.

## Main-session contract

The main session should delegate note lookup and synthesis to `agmo-wisdom`, then bring the result back into the active workflow.

Use this to:

- find prior design / plan / implementation notes
- recover earlier decisions
- link the current task to durable project context

## Search quality contract

Search is not just filename grep.

Default retrieval order:

1. current project note family
2. linked parent or related notes
3. neighboring notes with matching aliases or tags
4. broader vault matches only when project-local context is insufficient

Use metadata as evidence when available:

- `project_note`
- `parent`
- `related`
- `aliases`
- family tags such as `type/...`
- project or workflow tags

## Return shape

When returning results, include:

- the best canonical note candidate first
- nearby alternatives only when they add distinct context
- why each candidate is relevant
- the likely note family to update or extend
- whether a fresh note is preferable to mutating an existing one
