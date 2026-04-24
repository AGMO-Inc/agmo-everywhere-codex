---
name: git-workflow
description: Use when the user wants commit, push, PR, or branch management work in the current git repo. Triggers on requests like "커밋", "푸시", "PR", "pull request", "브랜치", or "git workflow".
argument-hint: "[commit, push, PR, or branch request]"
---

# Agmo Git Workflow

Use this for operational Git and GitHub branch flow in the current repository.

## Main-session contract

The leader stays in orchestration mode.

- delegate the primary mutation lane to `agmo-executor`
- use `agmo-verifier` before claiming a PR or release-ready branch is done when checks matter
- read repo-local policy from `AGENTS.md`, `README`, or `.github` before assuming commit or PR conventions

## Preflight

Before mutating git state, verify:

1. the cwd is inside a git repo
2. `git status --short --branch` and the relevant diff were inspected
3. the intended remote/upstream situation is understood
4. token-first GitHub auth is understood before PR work or GitHub remote mutations

## GitHub auth lane

- GitHub operations in this skill use the `gh` CLI, not a GitHub MCP server
- prefer token-based auth for GitHub automation and repo mutation work
- prefer `GH_TOKEN`, then `GITHUB_TOKEN`, for `gh` on `github.com`; use the enterprise token variants when the target host requires them
- before push, PR, or other GitHub mutations, check for the token environment variable without printing the token value
- when a token environment variable is present, use that token-backed `gh`/git path and do not fall back to macOS Keychain or another existing credential helper
- verify token-backed auth with `gh auth status` before PR work or other GitHub mutations
- for GitHub HTTPS git operations, prefer `gh auth setup-git` or another token-backed non-interactive credential path that runs under the same token environment
- never open interactive `gh auth login` or browser/device flows when a token environment variable is already available
- never persist tokens into tracked files, commit contents, or remote URLs; keep them in process environment or other non-tracked credential storage only
- treat existing Keychain or credential-helper auth as an explicit fallback only when no token environment variable is available
- if neither token env nor an explicitly accepted non-interactive fallback is available, stop at the exact blocker and report the missing prerequisite
- when the runtime asks for command approval, request a reusable command prefix for the specific git/gh operation so later commit, push, and PR steps do not repeatedly interrupt the user

## Commit lane

- stage only the intended paths; never blanket-add unrelated files unless the user explicitly asked for that reviewed scope
- inspect the staged diff before commit
- write the commit message around why, not just what changed
- if the repo has a required commit contract, such as structured trailers, follow it
- never use `--no-verify`
- never amend unless the user explicitly asks

## Push and branch lane

- prefer token-backed non-interactive auth for GitHub remotes; do not rely on interactive credential prompts
- prefer `git push -u origin <branch>` when the branch has no upstream yet
- verify the current branch before pushing or deleting anything
- do not force-push protected branches unless the user explicitly asks and the risk is surfaced
- avoid mixing unrelated dirty-worktree changes into the branch operation

## PR lane

- review the full branch diff or commit range, not just the latest commit
- run the relevant build, lint, typecheck, or test commands when the repo exposes them
- stop and report failures instead of opening a misleading PR
- include a concise summary, verification evidence, and notable risks in the PR body
- if the repo has `CHANGELOG.md` and the change is user-facing, check whether it should be updated before finishing

## Safety

- never commit secrets, `.env`, or credentials
- never force-push `main`, `master`, or another protected release branch by default
- if the worktree contains unrelated user changes, preserve them and stage only the requested scope
- report the exact git/gh action taken, plus any verification gaps that remain
