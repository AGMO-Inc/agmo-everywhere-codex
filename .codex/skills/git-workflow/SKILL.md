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
4. `gh auth status` is available before PR work

## Commit lane

- stage only the intended paths; never blanket-add unrelated files unless the user explicitly asked for that reviewed scope
- inspect the staged diff before commit
- write the commit message around why, not just what changed
- if the repo has a required commit contract, such as structured trailers, follow it
- never use `--no-verify`
- never amend unless the user explicitly asks

## Push and branch lane

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
