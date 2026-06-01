---
name: wiki-maintain
description: Audit and maintain the vault-backed llm-wiki knowledge base, including stale pages, low-confidence or contested captures, superseded captures, missing frontmatter, and broken wikilinks.
argument-hint: "[project name]"
---

# LLM Wiki Maintenance

Use this when session-start reports wiki health warnings, when wiki context looks stale, or before relying on full llm-wiki context for a project.

Run:

```bash
agmo wiki maintain --project <project> --format markdown
```

For machine-readable output:

```bash
agmo wiki maintain --project <project> --format json
```

Working rules:

- Treat the llm-wiki under `<vault_root>/.agmo/llm-wiki` as the SSOT for startup knowledge.
- Session start injects the manifest by default. Use `agmo wiki context --project <project> --full` only when full body context is needed.
- Do not rely on superseded captures; full context excludes them.
- Resolve high-severity `LOW_CONFIDENCE` and `CONTESTED` findings before using the affected page as evidence.
- Use `agmo wiki migrate-wisdom --scope project --project <project> --dry-run` to preview migration from legacy `.agmo/memory/wisdom.json`.
