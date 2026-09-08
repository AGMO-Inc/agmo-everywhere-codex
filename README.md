# agmo-everywhere-codex

<div align="center">

<img src="docs/assets/github-small.svg" alt="GitHub" height="28" />
<img src="docs/assets/codex-small.svg" alt="Codex" height="28" />

### Agmo rebuilt for Codex

Codex-native Agmo runtime and plugin for planning, execution, verification, GitHub workflows, vault persistence, and tmux-backed team orchestration.

[![Version](https://img.shields.io/badge/version-0.1.7-1f2937.svg)](package.json)
[![CLI](https://img.shields.io/badge/runtime-agmo%20CLI-0f766e.svg)](packages/agmo-cli)
[![Plugin](https://img.shields.io/badge/plugin-Codex%20native-1d4ed8.svg)](packages/agmo-plugin)
[![Agents](https://img.shields.io/badge/agents-7-14532d.svg)](#managed-native-agent-roster)
[![Skills](https://img.shields.io/badge/skills-18-b45309.svg)](#skill-surface)
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

The setup output also reports vault status. If no vault is configured yet, run the suggested `agmo vault config set-root ...` command before relying on wisdom or note persistence.

### Choose the install scope

```bash
agmo setup --scope user
agmo setup --scope project
```

- `user`: installs into `~/.codex` and `~/.agmo`
- `project`: installs into `<repo>/.codex` and `<repo>/.agmo`

### Configure the Obsidian vault

Vault-backed wisdom is optional, but recommended. Agmo does not hardcode a machine-specific vault path during plugin installation.

For one project:

```bash
agmo vault config set-root "/path/to/obsidian/vault" --scope project
agmo vault config show
```

For a user-wide default:

```bash
agmo vault config set-root "/path/to/obsidian/vault" --scope user
agmo vault config show
```

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
| `agmo-planner` | planning and decomposition | `gpt-6-astra` | `xhigh` |
| `agmo-executor` | direct implementation | `gpt-6-astra` | `medium` |
| `agmo-verifier` | verification and proof | `gpt-6-astra` | `medium` |
| `agmo-wisdom` | durable knowledge and note synthesis | `gpt-5.6-terra` | `medium` |
| `agmo-architect` | read-only design and tradeoffs | `gpt-6-astra` | `xhigh` |
| `agmo-critic` | plan and design challenge | `gpt-6-astra` | `xhigh` |
| `agmo-explore` | fast repo fact gathering | `gpt-5.6-luna` | `low` |

Hook execution ownership requires syncing both project and user installations so their managed commands include `--scope`; legacy unscoped direct hook calls continue to execute during migration. Session-state locks fail closed after a bounded timeout when ownership is stale or unreadable, with owner/path diagnostics. Remove such a lock manually only after confirming its owner is no longer active.

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
- `wiki-maintain`
- `debt`

### Verification, review, and GitHub skills

- `verify`
- `code-review`
- `git-workflow`
- `create-issue`
- `note-to-issue`

### Git and GitHub additions

These three are modeled after the Claude Code plugin project, but adapted for Codex-native lanes and Agmo runtime contracts:

- `git-workflow`: commit, push, PR, and branch operations
- `create-issue`: create GitHub issues from conversation or repo context
- `note-to-issue`: convert an existing vault or markdown note into a GitHub issue

### Review and debt additions

- `code-review`: run Codex-native staged review through `agmo-critic` and `agmo-verifier` where proof is needed
- `debt`: harvest `debt:` markers into a read-only ledger and hand selected rows to `plan` only after confirmation
- `wiki-maintain`: audit and maintain the vault-backed llm-wiki knowledge base

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

Use `--scope project` for a repository-specific vault, or `--scope user` for a default shared by Agmo workspaces on the same machine. The selected path is stored in `.agmo/config.json` for project scope or `~/.agmo/config.json` for user scope.

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
agmo team api get-summary --input '{"team_name":"<team-name>"}' --json
agmo team api create-task --input '{"team_name":"<team-name>","subject":"Follow-up","description":"Implement the follow-up slice"}' --json
agmo team status <team-name>
agmo team monitor <team-name> --preset balanced --leader-view
agmo team integrate <team-name> --strategy squash --target-ref @base
agmo team integrate-assist <team-name>
```

### Team Runtime HUD and layout

Use durable team state first when operating a team: `agmo team status <team-name>` and the JSON
`agmo team api ...` surfaces read `.agmo/state/team/<team-name>/...` without depending on tmux pane output.
For teams using tmux, `agmo team hud <team-name>` renders a leader HUD from the same durable state.

Practical HUD presets:

- `agmo team hud <team-name> --preset sidecar` is the compact tmux-friendly HUD; team-created HUD panes use this
  preset with a bounded height.
- `agmo team hud <team-name> --preset focused` is the default CLI HUD view for operator triage. It expands worker
  diagnostics and limits command hints to read-only or dry-run-safe actions.
- `agmo team hud <team-name> --preset full` adds deeper diagnostics, including open task rows and manual/mutating
  action hints for an operator to review before running.

Use `--watch` for a live terminal view, with `--refresh-ms <ms>` and `--iterations <n>` when you need a bounded
refresh loop. `--json` is for machine reads and cannot be combined with `--watch`.

The sidecar HUD may show `inspect=` hints when worker, task, or layout state needs attention. Treat those as
read-only next checks, such as worker/task status review or `agmo team layout status <team-name>`, before running a
repair or rebalance command. Layout operations are:

```bash
agmo team layout status <team-name>
agmo team layout repair <team-name> --dry-run
agmo team layout rebalance <team-name> --dry-run
```

`layout status` reports tmux layout health when the team uses tmux and returns a skipped/not-configured result for
non-tmux teams. Prefer `repair --dry-run` or `rebalance --dry-run` before applying repair/rebalance; repair targets
missing or dead HUD panes, while rebalance applies an `auto`, `main-vertical`, or `tiled` tmux layout plan.

Machine-oriented JSON commands keep existing `command` fields and add a stable envelope:
`schema_version`, `operation`, and `ok`, plus `recommended_actions` when actionable guidance is available.
Current envelope-backed surfaces include `agmo doctor`, JSON-producing `agmo team` commands,
JSON-producing `agmo cleanup` commands, and JSON-producing `agmo vault` commands.

`agmo doctor` includes a nested `disk_usage` section for the current project's `.agmo` directory. This section is
info-only: it measures usage with the cleanup inventory, reports cleanup candidates from retention policy plus
effective cleanup caps, and keeps its recommendations separate from top-level doctor `ok` status. `disk_usage`
uses `candidate_basis: "retention_policy_and_effective_caps"` and includes compact `effective_caps` and `pressure`
metadata from the cleanup plan. `agmo doctor --scope user` still measures the current project's `.agmo` footprint;
`--scope user` only changes setup/config diagnostics. Moving or relocating global/user Agmo state does not resolve
current-project disk pressure because project runtime artifacts remain under the project root.

Use the cleanup flow in order:

```bash
agmo cleanup inspect --json --verbose
agmo cleanup plan --json --verbose
agmo cleanup run --confirm --json
```

`inspect` and `plan` are non-mutating. `run` deletes only after `--confirm` and follows the cleanup plan. Cleanup
selection is deterministic: retention TTL candidates are selected first, configured category caps run second, and
the effective project byte cap runs last. Configured cap value `0` disables that configured cap. Explicit
`--max-bytes 0` is strict, and any explicit `--max-bytes` overrides only `max_project_agmo_bytes`; configured
`max_launch_workspace_bytes` and `max_state_files` still apply. Nonzero configured defaults are enforced for plain
cleanup plans, so a plan can include cap-selected candidates even without CLI cap flags.

Cleanup JSON keeps existing fields and additively includes `effective_caps` plus `pressure`. Pressure reports
before/after values, selected entries/bytes, protected or ineligible skipped entries/bytes, and
`reachable: false` with `unreachable_reason: "no eligible entries remain before cap target"` when protected entries
prevent a cap target from being reached. Launch workspace deletion is revalidated at delete time: metadata,
session identity, launch state, path kind, realpath containment, and Git dirty state must still match the safe
planned facts, or the entry is skipped instead of removed.

Launch can also opt in to safe automatic cleanup of old clean launch TTL candidates and paired session instructions
under the existing cleanup policy. Cap-selected cleanup reasons are not eligible for launch auto-cleanup:

```bash
agmo config cleanup set safe_auto_cleanup_on_launch true --scope project
```

For machine interop, `agmo team api <send-message|broadcast|mailbox-list|mailbox-mark-delivered|mailbox-mark-notified|create-task|update-task|release-task-claim|read-config|read-manifest|read-worker-status|read-worker-heartbeat|update-worker-heartbeat|write-worker-inbox|write-worker-identity|append-event|read-events|await-event|read-monitor-snapshot|write-monitor-snapshot|write-shutdown-request|read-shutdown-ack|read-idle-state|read-stall-state|read-task-approval|write-task-approval|read-task|list-tasks|get-summary|cleanup|orphan-cleanup|claim-task|transition-task-status> --input '<json>' --json`
returns an OMC-style envelope with either `data` or `error`; lifecycle mutation is limited to claim-safe
claim/release and `in_progress -> completed|failed` terminal transitions. Mailbox operations expose durable
message send/list/mark state and worker inbox replacement. Worker heartbeat and identity writes use durable
team state files, while event APIs append, read, and await canonical durable team event records. Monitor
snapshot APIs expose the durable `monitor-snapshot.json` file without requiring consumers to tail tmux panes.
Shutdown handshake APIs write durable request state and read worker acknowledgements without finalizing the
team or closing panes. Idle/stall APIs derive leader-facing state from durable worker status, heartbeats,
tasks, dispatch, and events. Task approval APIs persist reviewer decisions and append approval events.
Team cleanup APIs are dry-run by default and require `confirm_cleanup: true` or `force: true` before shutdown.
Task creation uses durable numeric IDs and `list-tasks`/`read-task` include dynamically created task files.

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
