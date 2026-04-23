# agmo-everywhere-codex

<div align="center">

<img src="docs/assets/github-small.svg" alt="GitHub" height="28" />
<img src="docs/assets/codex-small.svg" alt="Codex" height="28" />

### Agmo rebuilt for Codex

Codex-native Agmo runtime and plugin for planning, execution, verification, GitHub workflows, vault persistence, and tmux-backed team orchestration.

[![Version](https://img.shields.io/badge/version-0.1.0-1f2937.svg)](package.json)
[![CLI](https://img.shields.io/badge/runtime-agmo%20CLI-0f766e.svg)](packages/agmo-cli)
[![Plugin](https://img.shields.io/badge/plugin-Codex%20native-1d4ed8.svg)](packages/agmo-plugin)
[![Agents](https://img.shields.io/badge/agents-7-14532d.svg)](#managed-native-agent-roster)
[![Skills](https://img.shields.io/badge/skills-15-b45309.svg)](#skill-surface)
[![License](https://img.shields.io/badge/license-MIT-6b7280.svg)](LICENSE)

</div>

---

Agmo Everywhere for Claude Code established the workflow shape. This repository rebuilds that product around Codex-native primitives:

- managed native agents under `.codex/agents`
- managed skills under `.codex/skills`
- native hook wiring through `.codex/hooks.json`
- project/user runtime state under `.agmo/state`
- built-in vault and wisdom flows
- optional tmux + git-worktree team runtime

## Why This Exists

Codex already has strong local execution and agent delegation primitives. Agmo adds a tighter operating model on top:

- a canonical workflow chain: `brainstorming -> plan -> plan-review -> execute -> team`
- durable project memory instead of chat-only context
- explicit planning, execution, verification, and wisdom lanes
- Git and GitHub skill surfaces for commits, PRs, and issue creation
- repeatable setup for both user-wide and project-local installs

## Quick Start

### Install the CLI

```bash
npm install -g agmo
```

### Run setup

```bash
agmo setup
```

`agmo setup` installs both parts of the product together:

- Agmo runtime
  - managed native agents
  - hooks
  - `AGENTS.md`
  - `.agmo/config.json`
- Codex plugin bundle
  - plugin manifest
  - managed skills
  - MCP placeholders
  - scoped activation in `.codex/config.toml`

### Choose the install scope

```bash
agmo setup --scope user
agmo setup --scope project
```

- `user`: installs into `~/.codex` and `~/.agmo`
- `project`: installs into `<repo>/.codex` and `<repo>/.agmo`

### Launch a session

```bash
agmo launch
```

For CI or other non-interactive shells, pass `--scope` explicitly. Agmo will not guess.

## Versioning

Agmo keeps the CLI package, plugin package, plugin manifest, and README badge on one version.

```bash
pnpm version:check
pnpm version:sync 0.1.1
pnpm version:bump:patch
pnpm version:bump:minor
pnpm version:bump:major
pnpm version:prerelease:alpha
pnpm version:prerelease:beta
pnpm version:prerelease:rc
pnpm version:release
```

- root `package.json` is the source of truth
- `packages/agmo-cli/package.json` stays aligned for the published runtime
- `packages/agmo-plugin/package.json` and `packages/agmo-plugin/.codex-plugin/plugin.json` stay aligned for plugin installs
- `pnpm check` fails if those versions drift
- managed release channels are `alpha`, `beta`, `rc`, then `release`
- prerelease tags outside that policy are rejected by the sync script
- plugin validation checks manifest shape, skill bundle structure, and `.codex/skills` mirror parity

## What You Get

<table>
  <tr>
    <td valign="top" width="25%">
      <strong>Codex-native workflows</strong><br />
      Brainstorm, plan, review, execute, and escalate without leaving Codex-native surfaces.
    </td>
    <td valign="top" width="25%">
      <strong>GitHub-ready operations</strong><br />
      Use dedicated skills for commit/PR flow, conversation-to-issue, and note-to-issue conversion.
    </td>
    <td valign="top" width="25%">
      <strong>Vault + wisdom</strong><br />
      Keep plans, implementation notes, research, and project decisions durable outside transient chat.
    </td>
    <td valign="top" width="25%">
      <strong>Team runtime</strong><br />
      Scale from one execution lane to tmux-backed workers with worktrees, integration policy, and monitoring.
    </td>
  </tr>
</table>

## Recommended Workflow

```text
brainstorming -> plan -> plan-review -> execute -> team
```

### Public stages

- `brainstorming`: shape ideas and tradeoffs with `agmo-planner`, `agmo-explore`, and `agmo-architect`
- `plan`: produce an execution-ready handoff
- `plan-review`: challenge or approve the plan before coding
- `execute`: implement with `agmo-executor` and prove with `agmo-verifier`
- `team`: escalate to durable multi-worker execution when one lane is no longer enough

### Compatibility aliases

- `design` routes to `brainstorming`
- `ralplan` routes to a higher-trust planning lane
- `ralph` routes to completion-gated execution

## Managed Native Agent Roster

Agmo keeps a small pinned roster under `.codex/agents/*.toml`.

| Agent | Role | Model | Reasoning |
| --- | --- | --- | --- |
| `agmo-planner` | planning and decomposition | `gpt-5.4` | `high` |
| `agmo-executor` | direct implementation | `gpt-5.4` | `high` |
| `agmo-verifier` | verification and proof | `gpt-5.4` | `high` |
| `agmo-wisdom` | durable knowledge and note synthesis | `gpt-5.4-mini` | `medium` |
| `agmo-architect` | read-only design and tradeoffs | `gpt-5.4` | `high` |
| `agmo-critic` | plan and design challenge | `gpt-5.4` | `high` |
| `agmo-explore` | fast repo fact gathering | `gpt-5.3-codex-spark` | `low` |

## Skill Surface

### Workflow skills

- `brainstorming`
- `plan`
- `plan-review`
- `execute`
- `team`

### Compatibility skills

- `design`
- `ralplan`
- `ralph`

### Knowledge and vault skills

- `wisdom`
- `vault-search`
- `save-note`

### Verification and GitHub skills

- `verify`
- `git-workflow`
- `create-issue`
- `note-to-issue`

### Git and GitHub additions

These three are modeled after the Claude Code plugin project, but adapted for Codex-native lanes and Agmo runtime contracts:

- `git-workflow`: commit, push, PR, and branch operations
- `create-issue`: create GitHub issues from conversation or repo context
- `note-to-issue`: convert an existing vault or markdown note into a GitHub issue

## Architecture

```text
packages/
├── agmo-plugin/
│   ├── .codex-plugin/plugin.json
│   ├── skills/
│   ├── .mcp.json
│   └── assets/
└── agmo-cli/
    ├── src/cli/
    ├── src/hooks/
    ├── src/prompts/
    ├── src/team/
    ├── src/vault/
    └── src/templates/
```

### Plugin layer

- reusable Codex plugin manifest
- managed skill catalog
- MCP server placeholders
- packaged assets bundled into installs

### Runtime layer

- `agmo setup`
- `agmo launch`
- native hook management
- runtime state under `.agmo/state/*`
- team runtime with tmux and git worktrees
- vault and wisdom commands
- integration and conflict-assist flows

## Vault and Wisdom

Agmo includes a built-in vault surface so durable notes do not depend on ad-hoc shell scripts.

### Configure the vault root

```bash
agmo vault config set-root "/path/to/obsidian/vault" --scope project
agmo vault config show
```

Vault root resolution order:

1. `AGMO_VAULT_ROOT`
2. project `.agmo/config.json`
3. user `~/.agmo/config.json`

### Core vault commands

```bash
agmo vault save --type impl --project agmo-everywhere-codex --title "Runtime Bootstrap" --file /tmp/runtime-bootstrap.md --index
agmo vault scaffold --type design --project agmo-everywhere-codex --title "Launch UX" --output /tmp/launch-ux.md
agmo vault create --type meeting --project agmo-everywhere-codex --title "Weekly Runtime Sync" --date 2026-04-22 --attendees "alice,bob" --index
```

### Wisdom commands

```bash
agmo wisdom show
agmo wisdom add learn "Prefer evidence-backed workflow routing."
agmo wisdom add decision "Keep execute and verify as separate lanes." --scope project
```

## Team Runtime

When one execution lane is no longer enough, Agmo can move into a durable team runtime instead of spawning ad-hoc short-lived fanout.

### Common commands

```bash
agmo team start 3 "Ship the scoped feature with verification"
agmo team status <team-name>
agmo team monitor <team-name> --preset balanced --leader-view
agmo team integrate <team-name> --strategy squash --target-ref @base
agmo team integrate-assist <team-name>
```

### Operational features

- worker-specific worktrees
- role-aware task allocation
- heartbeat and stale-worker detection
- optional monitor auto-nudge and auto-reclaim
- batched integration with conflict policy
- manual conflict assist note generation

## Git and GitHub Workflow

Agmo now has an explicit Git/GitHub lane instead of hiding these behaviors inside generic execution.

### Commit and PR flow

```text
"커밋해줘" -> git-workflow
"PR 만들어줘" -> git-workflow
```

`git-workflow` is opinionated about:

- staging only intended files
- checking diffs before commit
- respecting repo-local commit policy
- avoiding `--no-verify`
- running tests or checks before PR creation when the repo exposes them

### Issue creation flow

```text
"이 내용으로 이슈 만들어줘" -> create-issue
"이 노트를 이슈로 바꿔줘" -> note-to-issue
```

- `create-issue` is for conversation-to-issue or repo-context issue creation
- `note-to-issue` is for converting an existing note artifact

## Development

### Monorepo commands

```bash
pnpm install
pnpm check
pnpm build
```

### Package roles

- `packages/agmo-plugin`: installable Codex plugin surface
- `packages/agmo-cli`: setup/runtime/launch/team/vault CLI

## Design Notes

This README intentionally mirrors the readability pattern of the earlier Claude Code plugin project:

- centered hero
- high-signal badges
- quick-start-first layout
- workflow-oriented sectioning
- compact tables instead of long prose dumps

The content itself is Codex-first and reflects the current Agmo runtime contract in this repository.

## License

MIT
