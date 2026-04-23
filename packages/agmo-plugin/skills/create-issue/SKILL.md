---
name: create-issue
description: Use when the user wants a GitHub issue created from the current conversation or repo context. Triggers on requests like "이슈 만들어", "깃허브 이슈", "create issue", or "new issue". If the source artifact is an existing vault note, use `note-to-issue` instead.
argument-hint: "[issue request, repo context, or ticket draft]"
---

# Agmo Create Issue

Use this when the user wants a GitHub issue created from the current discussion rather than from an existing note file.

## Main-session contract

The leader should keep orchestration ownership.

- use `agmo-wisdom` when the issue body needs help shaping requirements or turning rough discussion into a clean ticket
- delegate the GitHub mutation lane to `agmo-executor`
- verify the created artifact with `gh` output before reporting success

## Preflight

Before creating anything, verify:

1. the cwd is inside the target git repo
2. `origin` resolves to the intended GitHub owner/repo
3. token-first GitHub auth is available and `gh auth status` succeeds
4. any repo-local issue policy in `AGENTS.md`, `README`, or `.github` has been checked

## GitHub auth lane

- prefer token-based auth for GitHub issue and project mutations
- prefer `GH_TOKEN`, then `GITHUB_TOKEN`, for `gh` on `github.com`; use the enterprise token variants when the target host requires them
- never open interactive `gh auth login` when a token environment variable is already available
- never persist tokens into tracked files, issue bodies, shell history snippets committed to the repo, or remote URLs
- if token env is missing and `gh auth status` is not already healthy, stop at the exact auth blocker and report it

Prefer repo-local conventions first. If no stronger local convention exists, default to a simple `Feature` / `Task` / `Bug` split with titles like `[Feature] ...`, `[Task] ...`, and `[Bug] ...`.

## Single-prompt collection

Ask once for any missing fields instead of doing multiple rounds.

Typical missing data:

- issue type
- status for project-board placement
- parent feature issue when creating a task
- any required repo-specific template section the conversation did not provide

## Create flow

1. resolve owner/repo from `git remote get-url origin`
2. detect duplicate risk first when practical, for example via `gh issue list --search`
3. create the issue with `gh issue create`
4. if the installed `gh` supports issue types, set the GitHub type directly
5. if project-board metadata is known, add the issue to the project and set status
6. verify the final issue URL, number, assignee, and any parent link with `gh issue view`

## Project integration

Project-board registration is best-effort, not assumed.

- prefer repo-local or org-local project metadata when it exists
- if project number, owner, or status field mapping is unknown, ask once before attempting project edits
- if the issue was created but project integration failed, report partial success clearly instead of claiming the whole workflow passed

## Safety

- do not create a task issue without the required parent feature reference when the workflow demands it
- do not silently create duplicate issues when an obvious open match already exists
- do not claim issue type or project status were applied unless `gh` output confirms it
- if GitHub CLI capability or permissions are insufficient, stop at the exact blocker and report it
