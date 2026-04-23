---
name: save-note
description: Use when the current run should persist a durable decision, checkpoint, or summary into the vault.
argument-hint: "[summary, decision, or note purpose]"
---

# Agmo Save Note

Use this when the result should survive outside transient chat.

## Main-session contract

The main session should delegate durable note preparation to `agmo-wisdom`, then persist the resulting summary through Agmo's vault path.

Use this for:

- explicit checkpoint saves
- decision records
- concise summaries the user wants preserved outside transient chat

## Durable note quality bar

Do not save a raw transcript dump when a cleaner artifact summary is possible.

Default expectation:

1. choose the right note family first (`design`, `plan`, `implementation`, `research`, `memo`)
2. propose an artifact-centered title, not a chatty prompt echo
3. preserve project linkage and nearby parent/related notes
4. include aliases when prior phrasing matters for search
5. include tags that support both family-based and topic-based retrieval

## Before saving

Normalize obvious low-quality inputs such as:

- worker bootstrap prompts
- dispatch/inbox text
- conversational titles like `응 진행해줘`
- titles that restate the action instead of the artifact

## Minimum save payload

- note type
- final title
- concise summary or structured bullets
- aliases
- tags
- parent / related links when known
