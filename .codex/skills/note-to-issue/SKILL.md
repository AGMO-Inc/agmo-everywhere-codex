---
name: note-to-issue
description: Use when the user wants to convert an existing vault note or markdown note into a GitHub issue. Triggers on requests like "노트로 이슈", "이슈로 변환", "convert note to issue", or "note to issue". For issue creation from conversation context without a source note, use `create-issue` instead.
argument-hint: "[note path, vault note, or markdown-to-issue request]"
---

# Agmo Note To Issue

Use this when an existing note file is the source artifact for the GitHub issue.

## Main-session contract

The leader should keep orchestration ownership.

- use `agmo-wisdom` to interpret the note, extract the strongest issue shape, and identify missing fields
- delegate GitHub mutations and note-file updates to `agmo-executor`
- verify both the created issue and the updated note before reporting completion

## Preflight

Before conversion, verify:

1. the source note path is known
2. the vault root is configured when the user references a vault-relative note
3. the note can be read locally
4. token-first GitHub auth is available and `gh auth status` succeeds for the target repo

Prefer resolving vault location through `agmo vault config show` or `AGMO_VAULT_ROOT`. If the vault root is not configured and the user only gave a vault-relative path, stop and ask for the missing path or vault config.

## GitHub auth lane

- GitHub operations in this skill use the `gh` CLI, not a GitHub MCP server
- prefer token-based auth for GitHub issue and project mutations
- prefer `GH_TOKEN`, then `GITHUB_TOKEN`, for `gh` on `github.com`; use the enterprise token variants when the target host requires them
- never open interactive `gh auth login` when a token environment variable is already available
- never persist tokens into tracked note content, tracked files, or remote URLs
- if token env is missing and `gh auth status` is not already healthy, stop at the exact auth blocker and report it

## Note ingestion

- read the source markdown directly
- use frontmatter as evidence when present
- if the note already contains an issue number, issue URL, or obvious GitHub backlink, treat that as duplicate risk and ask before creating another issue
- derive owner/repo from note metadata when available; otherwise fall back to the current repo remote

## Single-prompt collection

Ask once for any missing fields, typically:

- issue type
- project status
- parent feature issue for a task
- any ambiguous title/body section that the note does not make clear

## Conversion flow

1. map the note title and body into a clean issue title and body
2. create the issue through the same GitHub flow used by `create-issue`
3. if project metadata is available, register the issue to the project board and set status
4. update the source note with the created issue number and URL
5. verify both the GitHub artifact and the note mutation

## Source note update

When updating the note:

- preserve existing frontmatter formatting as much as possible
- add or update issue metadata rather than rewriting unrelated fields
- append a clear backlink to the created GitHub issue in the body when one does not already exist
- avoid destructive rewrites of the surrounding note content

## Safety

- do not proceed when the note reference is ambiguous
- do not create a duplicate issue without explicit confirmation when the note already links to one
- do not claim vault-note update success unless the file contents were re-read and verified
- if vault configuration or GitHub permissions are missing, stop at the exact blocker and report it
