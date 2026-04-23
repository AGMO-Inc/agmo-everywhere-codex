# agmo-everywhere-codex

Codex-native rebuild of Agmo with a split architecture:

- `packages/agmo-plugin`: reusable Codex plugin surface
- `packages/agmo-cli`: npm runtime for setup, hooks, agents, and team orchestration

## Installation and setup

Agmo is designed to be installed as a CLI package and then activated with `agmo setup`.

### 1. Install the CLI

```bash
npm install -g agmo
```

### 2. Run setup

```bash
agmo setup
```

When you run `agmo setup` in an interactive terminal, Agmo now asks which scope you want:

- `user` / `global`
  - installs into `~/.codex` and `~/.agmo`
  - good when you want Agmo available across all local projects
- `project`
  - installs into `<project>/.codex` and `<project>/.agmo`
  - good when you want the setup isolated to one repository

Setup applies the chosen scope to both parts of the product:

- the **Agmo CLI runtime** setup
  - managed agents
  - hooks
  - `AGENTS.md`
  - `.agmo/config.json`
- the **Codex plugin** setup
  - plugin marketplace files
  - plugin cache/install bundle
  - plugin activation in the scoped `.codex/config.toml`

### Explicit scope examples

If you already know the target scope, you can skip the prompt:

```bash
agmo setup --scope user
agmo setup --scope project
```

### Non-interactive environments

In CI, scripts, or any non-interactive shell, `agmo setup` cannot ask the question for you.
In those cases, pass the scope explicitly:

```bash
agmo setup --scope user
# or
agmo setup --scope project
```

If you omit `--scope` outside an interactive terminal, Agmo exits with an error instead of guessing.

## Recommended workflow surface

Agmo's public workflow is:

`brainstorming -> plan -> plan-review -> execute -> team`

- `brainstorming`: shape ideas, tradeoffs, and design direction with `agmo-explore`/`agmo-architect` support as needed
- `plan`: create an execution-ready handoff via `agmo-planner`, using `agmo-explore` for repo facts and `agmo-architect` for boundary/tradeoff checks when needed
- `plan-review`: challenge or approve the plan before coding via `agmo-critic`, `agmo-architect`, and/or `agmo-verifier`
- `execute`: start implementation in the current session, with `agmo-explore` for missing repo facts, `agmo-architect` for unresolved design tension, `agmo-executor` for coding, and `agmo-verifier` for proof
- `team`: escalate to durable tmux workers when one execution lane is no longer enough

`design` remains available only as a compatibility alias that routes into `brainstorming`; it is not a separate public workflow stage.
`ralplan` remains available as a compatibility alias that routes into the planning lane for a consensus-style, higher-trust planning pass; it is not a separate public workflow stage.

## Managed native agent roster

Agmo keeps a small managed native roster under `.codex/agents/*.toml`. Workflow routing treats these as first-class lanes:

- `agmo-planner` — planning, decomposition, and execution sequencing
- `agmo-executor` — direct implementation and task completion
- `agmo-verifier` — verification, testing, and completion evidence review
- `agmo-wisdom` — durable knowledge retrieval and note synthesis
- `agmo-architect` — read-only system design, boundary, and tradeoff analysis
- `agmo-critic` — read-only plan and design challenge lane
- `agmo-explore` — fast repo fact gathering and file/symbol mapping

### Pinned model policy

These managed agents are intentionally pinned in-repo so installs and workflow routing stay predictable:

| agent | model | reasoning effort |
| --- | --- | --- |
| `agmo-planner` | `gpt-5.4` | `medium` |
| `agmo-executor` | `gpt-5.4` | `high` |
| `agmo-verifier` | `gpt-5.4` | `high` |
| `agmo-wisdom` | `gpt-5.4-mini` | `medium` |
| `agmo-architect` | `gpt-5.4` | `high` |
| `agmo-critic` | `gpt-5.4` | `high` |
| `agmo-explore` | `gpt-5.3-codex-spark` | `low` |

If the managed roster or any pin changes, update the checked-in agent TOMLs and workflow docs together.

## Planned architecture

### Plugin layer

- Codex plugin manifest
- Skills
- MCP configuration placeholders
- Assets

### Runtime layer

- `agmo setup`
- Native agent TOML generation
- `.codex/hooks.json` management
- `AGENTS.md` generation
- `.agmo/state/*` runtime state
- tmux + worktree team runtime
- monitor + auto-nudge / auto-reclaim (`agmo team monitor --auto-nudge --auto-reclaim`)
- monitor presets / cooldown tuning (`agmo team monitor --preset balanced`)
- claim reclaim + reassignment (`agmo team reclaim --reassign`)
- tuned pending-task rebalance (`agmo team rebalance ...`)
- leader-friendly monitor view (`agmo team monitor --leader-view`)
- compact HUD + optional tmux HUD pane (`agmo team hud`, `team start --hud`)
- Obsidian-first vault config/save/scaffold/create commands (`agmo vault ...`)
- optional git-based auto integration with conflict policies (`agmo team integrate`, `team complete --auto-integrate`)
- role-aware initial task allocation for planner/executor/verifier/wisdom lanes
- tunable tmux HUD refresh controls (`team start --hud --hud-refresh-ms ...`, `team hud --watch`)
- richer Obsidian note linking policy (`project_note`, `parent`, `related`, returned wikilinks)
- expanded integration strategies + conflict assist (`--strategy squash`, `team integrate-assist`)
- monitor escalation/leader alert tuning (`leader-alerts.json`, escalation thresholds/cooldowns)
- leader alert delivery surface (`team alert-delivery`, mailbox + Slack webhook + sendmail email bridge)
- dependency-aware claim gating (`depends_on`, blocked tasks, unblock notifications)
- explicit initial allocation overrides (`--allocation-intent`, `--role-map`)
- vault template overrides and custom schema fields (`--template-file`, `--schema`, `--field`)
- richer integration batching + target-branch policy (`--batch-size`, `--batch-order`, `--target-ref`)

## Obsidian-first vault workflow

Agmo’s runtime now includes a built-in vault surface so the plugin can save and scaffold notes without relying on external shell scripts.

### Configure vault root

```bash
agmo vault config set-root "/path/to/obsidian/vault" --scope project
agmo vault config show
```

Vault root resolution order:

1. `AGMO_VAULT_ROOT`
2. project `.agmo/config.json`
3. user `~/.agmo/config.json`

### Tune autosave policy per workflow

Use workflow-specific autosave toggles when a canonical vault should keep implementation/design notes but skip transient lanes like verification:

```bash
agmo config vault-autosave show
agmo config vault-autosave set workflow_enabled.verify false --scope project
agmo config vault-autosave unset workflow_enabled.verify --scope project
```

The current project uses this to stop `verify` autosaves from generating transient memo notes in the canonical Obsidian vault while still preserving `execute`, `plan`, `brainstorming`, and research-oriented checkpoints.

### Save an existing markdown file into the vault

```bash
agmo vault save \
  --type impl \
  --project agmo-everywhere-codex \
  --title "Runtime Bootstrap" \
  --file /tmp/runtime-bootstrap.md \
  --index
```

### Scaffold a new Obsidian note template

```bash
agmo vault scaffold \
  --type impl \
  --project agmo-everywhere-codex \
  --title "Vault Scaffold Improvements" \
  --issue 123 \
  --pr 456 \
  --plan '[[agmo-everywhere-codex/plans/[Plan] Runtime Bootstrap]]' \
  --aliases "Vault Scaffold Improvements,Scaffold Improvements" \
  --tags "obsidian,vault" \
  --output /tmp/vault-scaffold.md
```

### Create and save a scaffolded note directly

```bash
agmo vault create \
  --type meeting \
  --project agmo-everywhere-codex \
  --title "Weekly Runtime Sync" \
  --date 2026-04-22 \
  --attendees "alice,bob" \
  --tags "weekly,team-sync" \
  --index
```

### Tune note linking policy

```bash
agmo vault scaffold \
  --type impl \
  --project agmo-everywhere-codex \
  --title "Vault Linking Policy" \
  --plan 'agmo-everywhere-codex/plans/[Plan] Runtime Bootstrap' \
  --parent 'agmo-everywhere-codex/agmo-everywhere-codex' \
  --related 'agmo-everywhere-codex/designs/[Design] Runtime UX,https://example.com/ref'
```

### Override the template and note schema

```bash
agmo vault scaffold \
  --type impl \
  --project agmo-everywhere-codex \
  --title "Custom Schema Impl" \
  --schema custom-impl \
  --field owner=platform \
  --field area=runtime \
  --template-file /path/to/template.md
```

Supported note types:

- `plan`
- `impl`
- `design`
- `research`
- `meeting`
- `memo`

Scaffolds are Obsidian-oriented:

- safe YAML frontmatter output for links, issue/pr refs, and strings with special characters
- default `aliases` entry using the clean note title
- default type/project tags plus optional extra `--tags`
- consistent `created` / `updated` fields
- project index note auto-append with `--index`
- explicit `project_note` field pointing at the project index note
- optional `parent` and `related` link metadata
- `Related Links` body section with internal wikilinks and external URLs
- `vault create` / `vault save` results include canonical `wikilink` and `project_wikilink`
- optional `schema` frontmatter field for custom note families
- repeatable `--field key=value` custom frontmatter extensions
- `--template-file` support with placeholders like `{{frontmatter}}`, `{{body}}`, `{{title}}`, `{{project}}`, and custom `{{fieldName}}`

## Git integration policy controls

Runtime-managed worker branch integration now exposes a few safety policies:

```bash
agmo team integrate my-team \
  --target-ref @base \
  --checkout-target \
  --strategy squash \
  --batch-size 2 \
  --batch-order oldest \
  --max-commits 3 \
  --on-conflict stop \
  --on-empty skip
```

- `--strategy cherry-pick|squash`: integrate commit-by-commit or squash the whole worker branch
- `--target-ref <ref|@base|@current>`: integrate onto the current ref, the team base ref, or an explicit branch/ref
- `--checkout-target`: automatically switch the repo root to the requested target ref before integrating
- `--batch-size <n>`: integrate only the first `n` matching completed tasks in this run
- `--batch-order oldest|newest|task-id`: choose how matching completed tasks are ordered before batching
- `--max-commits <n>`: skip large candidate integrations
- `--on-conflict continue|stop`: continue with later candidates or stop after the first conflict
- `--on-empty skip|fail`: skip empty cherry-picks caused by already-applied changes or treat them as failures

Integration history keeps structured metadata for:

- `batch_id`
- `batch_index`
- `batch_total`
- `applied_commits`
- `skipped_commits`
- `conflict_commit`
- `conflict_paths`
- `created_commit`
- `assist_path`
- `requested_target_ref`
- `target_ref`
- `target_source`

When an integration conflict occurs, Agmo now writes a manual-resolution assist note and you can reopen it with:

```bash
agmo team integrate-assist my-team
```

## Monitor auto-policy presets

`team monitor` now supports preset-driven operator policies:

```bash
agmo team monitor my-team --preset balanced
agmo team monitor my-team --preset aggressive --no-auto-reassign --leader-view
```

Available presets:

- `observe`: monitor only, no auto actions
- `conservative`: slower stale/dead thresholds with auto-nudge only
- `balanced`: auto-nudge + auto-reclaim + auto-reassign
- `aggressive`: faster thresholds, short nudge cooldown, reclaim stale workers too

You can still override individual behaviors:

- `--auto-nudge` / `--no-auto-nudge`
- `--auto-reclaim` / `--no-auto-reclaim`
- `--auto-reassign` / `--no-auto-reassign`
- `--include-stale` / `--no-include-stale`
- `--nudge-cooldown-ms <ms>`
- `--reclaim-lease-ms <ms>`

Each run saves the effective policy to:

- `.agmo/state/team/<team>/monitor-policy.json`

Leader escalation tuning is also available:

- `--escalate-leader|--no-escalate-leader`
- `--notify-on-stale|--no-notify-on-stale`
- `--notify-on-dead|--no-notify-on-dead`
- `--notify-on-claim-risk|--no-notify-on-claim-risk`
- `--leader-alert-cooldown-ms <ms>`
- `--escalation-repeat-threshold <n>`

Durable leader alert state is written to:

- `.agmo/state/team/<team>/leader-alerts.json`

Leader alerts can also fan out to a durable mailbox plus optional Slack/email bridges:

```bash
agmo team alert-delivery show my-team
agmo team alert-delivery set my-team --mailbox
agmo team alert-delivery set my-team --slack --slack-webhook-url https://hooks.slack.com/services/...
agmo team alert-delivery set my-team --email --email-to ops@example.com --email-from agmo@example.com
```

Notes:

- mailbox delivery writes a markdown feed and NDJSON payload log
- Slack delivery uses an incoming webhook URL
- email delivery uses a local `sendmail` bridge (default: `/usr/sbin/sendmail`)
- Slack/email config can also come from env: `AGMO_LEADER_ALERT_SLACK_WEBHOOK_URL`, `AGMO_LEADER_ALERT_EMAIL_TO`, `AGMO_LEADER_ALERT_EMAIL_FROM`, `AGMO_LEADER_ALERT_EMAIL_SENDMAIL_PATH`, `AGMO_LEADER_ALERT_EMAIL_SUBJECT_PREFIX`

Delivery artifacts are written to:

- `.agmo/state/team/<team>/leader-alert-delivery.json`
- `.agmo/state/team/<team>/leader-alert-deliveries.json`
- `.agmo/state/team/<team>/leader-alert-mailbox.md`
- `.agmo/state/team/<team>/leader-alert-mailbox.ndjson`

## Role-aware initial allocation

`team start` now assigns initial worker lanes based on task intent and worker count.

Examples:

- implementation-heavy task → planner + executor(s) + verifier
- Obsidian/vault implementation task with enough workers → planner + executor + wisdom + verifier
- research/doc task → wisdom + planner + verifier
- verification task → verifier + executor + planner

The `team start` result now includes `initial_roles` so the leader can inspect the first lane split immediately.

Dependent tasks now start in `blocked` state when they rely on earlier lanes, and they automatically move back to `pending` when dependencies complete.

If needed, a worker can still override the gate explicitly:

```bash
agmo team claim my-team 3 worker-3 --ignore-dependencies
```

If the default lane split is close but not quite right, you can steer it:

```bash
agmo team start 3 "Implement vault workflow" \
  --allocation-intent knowledge \
  --role-map worker-1=agmo-wisdom,worker-2=agmo-planner,worker-3=agmo-verifier
```

- `--allocation-intent`: force the initial lane family (`implementation|verification|planning|knowledge`)
- `--role-map`: override specific worker roles without disabling lane summaries/dependencies

`agmo team shutdown <team>` now also normalizes durable worker/task/dispatch state on disk so a stopped team no longer looks active because of leftover `working`, `pending`, or outstanding dispatch records.

If older sessions already left behind active-looking orphan teams, you can bulk-normalize them:

```bash
agmo team cleanup-stale --dry-run
agmo team cleanup-stale --include-stale
```

- default behavior only shuts down teams whose workers are all dead
- `--include-stale` also cleans teams that have no healthy workers left
- `--stale-ms` / `--dead-ms` let you tighten or relax the heartbeat thresholds used for cleanup
- `--dry-run` reports which teams would be normalized without mutating state

## HUD controls and refresh tuning

You can now tune HUD behavior both for direct CLI use and tmux panes:

```bash
agmo team hud my-team --watch --refresh-ms 1000 --no-clear
agmo team start 3 "Implement vault sync" --hud --hud-refresh-ms 5000 --hud-no-clear
```

Supported controls:

- `team hud --watch`: live-refresh in the current terminal
- `team hud --refresh-ms <ms>`: control refresh interval
- `team hud --clear|--no-clear`: clear or append between refreshes
- `team start --hud-refresh-ms <ms>`: set tmux HUD pane refresh interval
- `team start --hud-clear|--hud-no-clear`: control tmux HUD pane clearing behavior

The chosen tmux HUD settings are recorded in team config under:

- `config.tmux.hud_refresh_ms`
- `config.tmux.hud_clear_screen`

## Initial focus

1. Scaffold plugin + runtime packages
2. Implement `agmo setup`
3. Implement native agent sync
4. Implement hook sync
5. Implement team runtime MVP

## Workspace layout

```text
packages/
  agmo-plugin/
  agmo-cli/
```
