---
name: debt
description: Harvest `debt:` markers across the repo into a read-only ledger without modifying code.
argument-hint: "[optional path, area, or debt focus]"
---

# Debt

Use this skill when the user wants to inspect intentional simplification markers such as `// debt:` or `# debt:`. It is read-only: report the ledger, do not edit code, and do not resolve debt inside this skill.

## Process

1. Search the repo for markers:
   ```bash
   rg -n '(#|//) ?debt:' . \
     -g '!node_modules/**' \
     -g '!.git/**' \
     -g '!dist/**' \
     -g '!build/**' \
     -g '!.agmo/cache/**' \
     -g '!**/.pnpm-store/**' \
     -g '!**/.yarn/**'
   ```
2. Build a ledger grouped by file. For each marker, include `file:line`, the stated limitation, and the `upgrade:` trigger when present.
3. Tag markers that do not include an upgrade trigger as `no-trigger`.
4. Summarize with `<N> markers, <M> with no trigger.` If none are found, report `No debt markers. Clean ledger.`
5. Output the ledger to the user. Persist it only when the user explicitly asks; persistence is never automatic.

## Optional Handoff

After presenting the ledger, scan for `upgrade:` triggers that appear to be met. Offer, but do not auto-run, a handoff:

> "These markers may be ready to resolve: [list]. Which rows should I hand to `plan`?"

Only after explicit confirmation, route selected rows to `plan` with their `file:line`, limitation, and trigger. The normal plan -> execute path handles fixes. This skill still never edits markers or code.

## Constraints

- Read-only. Do not modify code, markers, plans, or vault notes unless the user explicitly asks for persistence.
- One-shot. Do not loop or re-scan unless requested.
- Use only the marker convention documented in the executor prompt: `// debt: <limitation>, upgrade: <trigger>` or `# debt: <limitation>, upgrade: <trigger>`.
- Do not fabricate savings, impact, or priority numbers. The ledger count is the only numeric claim this skill owns.
