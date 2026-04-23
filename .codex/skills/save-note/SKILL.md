---
name: save-note
description: "Agmo durable note persistence workflow. Use to persist a concise decision, checkpoint, or summary into the vault."
argument-hint: "[summary, decision, or note purpose]"
---

# Save Note

The main session should delegate durable note preparation to `agmo-wisdom`, then persist the resulting summary through Agmo's vault path.

Use this for:

- explicit checkpoint saves
- decision records
- concise summaries the user wants preserved outside transient chat

Keep the saved note focused and scoped to one durable artifact.

## Durable note quality bar

When preparing content for persistence, do not save a raw transcript dump.

Default expectation:

1. choose the right note family first (`design`, `plan`, `implementation`, `research`, `memo`)
2. propose an artifact-centered title, not a chatty prompt echo
3. preserve project linkage and nearby parent/related notes
4. include aliases for prior phrasing when helpful for search
5. include tags that help both family-based and topic-based retrieval

Before saving, normalize obvious low-quality inputs:

- worker bootstrap prompts like `You are worker-...`
- inbox/dispatch text
- conversational titles like `응 진행해줘`
- titles that only restate the action instead of the artifact

Minimum save payload:

- note type
- final title
- one-paragraph summary or structured bullets
- aliases
- tags
- parent / related links when known
