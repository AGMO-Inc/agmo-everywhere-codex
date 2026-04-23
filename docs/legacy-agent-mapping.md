# Legacy Agent Inventory and Agmo Mapping

## Scope

This inventory compares legacy agent prompts from `../agmo-everywhere/agents/*.md` against the current agent surfaces in this repo:

- Agmo-native definitions: `packages/agmo-cli/src/agents/definitions.ts`
- Agmo-native prompts: `packages/agmo-cli/src/prompts/*.md`
- Current broader native agents: `.codex/agents/*.toml`

Legacy filenames such as `architect.md`, `critic.md`, and `explore.md` are preserved below only as inventory labels. Their current managed canonical native-agent names in this repo are `agmo-architect`, `agmo-critic`, and `agmo-explore`.

## Current Agmo-native baseline

The current Agmo-native runtime manages these canonical native agents:

- `agmo-planner`
- `agmo-executor`
- `agmo-verifier`
- `agmo-wisdom`
- `agmo-architect`
- `agmo-critic`
- `agmo-explore`

That comes from `packages/agmo-cli/src/agents/definitions.ts`. The `agmo-architect`, `agmo-critic`, and `agmo-explore` entries also preserve their pre-normalization names as legacy aliases for migration compatibility, so new user-facing references should prefer the canonical `agmo-*` names.

## Legacy inventory and recommendation

| Legacy agent | Primary legacy purpose | Closest current surface(s) | Recommendation | Why |
| --- | --- | --- | --- | --- |
| `architect.md` | Read-only analysis, debugging, completion verification | `.codex/agents/agmo-architect.toml`, `.codex/agents/verifier.toml`, `packages/agmo-cli/src/prompts/verifier.md` | **Merge into existing agents** | The current repo already splits this role more cleanly: `agmo-architect` handles diagnosis/tradeoffs, while `verifier`/`agmo-verifier` own proof and completion review. |
| `archivist.md` | Mechanical vault save/search/update operations | `.codex/agents/agmo-wisdom.toml`, `packages/agmo-cli/src/prompts/wisdom.md` | **Merge concepts only; no new native agent** | Agmo already has a wisdom lane for retrieval and save-ready note prep. The legacy script-specific Obsidian operator is too workflow-specific to become a core native agent. Preserve only title/duplication/persistence ideas when updating save-note or wisdom flows. |
| `critic.md` | Structured review of plans and code | `.codex/agents/agmo-critic.toml` | **Merge into existing agents** | The current `agmo-critic` prompt is strictly richer than the legacy version and already covers plan-review rigor, simulation, and rejection criteria. |
| `executor.md` | Focused implementation with minimal code changes | `.codex/agents/executor.toml`, `packages/agmo-cli/src/prompts/executor.md` | **Merge into existing agents** | The legacy executor is a simpler predecessor of the current executor lane and aligns well with the smaller Agmo-native `agmo-executor` contract. |
| `explore.md` | Repo-local search and file discovery | `.codex/agents/agmo-explore.toml` | **Merge into existing agents** | The current `agmo-explore` agent preserves the same role but adds stronger search discipline, absolute-path requirements, and tool-selection guidance. |
| `frontend.md` | Browser/Figma/accessibility/responsive frontend quality gate | `.codex/agents/vision.toml`, `.codex/agents/designer.toml`, `.codex/agents/verifier.toml` | **Archive reference only** | No current native agent owns a browser-based quality gate contract. Importing it directly would imply screenshot capture/runtime assumptions that are not part of the current Agmo-native baseline. |
| `planner.md` | Interview-driven executable planning with acceptance criteria | `.codex/agents/planner.toml`, `packages/agmo-cli/src/prompts/planner.md` | **Merge into existing agents** | The role already exists both as a rich `planner` agent and as the smaller `agmo-planner` native lane. Keep the current Agmo-native surface small and import only any missing planning heuristics later if needed. |
| `android-specialist.md` | Compose/Figma/accessibility/responsive Android UI quality gate | `.codex/agents/vision.toml`, `.codex/agents/verifier.toml` | **Archive reference only** | This is highly specialized, Android-only, and depends on Compose preview capture conventions that are not represented in the current core agent/runtime surfaces. |

## Recommended migration buckets

### Direct new Agmo native agents

**Immediate recommendation: none.**

Reasoning:

1. `packages/agmo-cli/src/agents/definitions.ts` already includes the managed canonical `agmo-architect`, `agmo-critic`, and `agmo-explore` lanes alongside the core four agents.
2. Six of eight legacy agents already map cleanly onto existing current agents.
3. The two specialist quality-gate agents (`frontend`, `android-specialist`) depend on capture/runtime contracts that are not yet first-class in Agmo.

### Merge into existing agents

- `architect.md`
- `archivist.md` (concepts only, not the script API)
- `critic.md`
- `executor.md`
- `explore.md`
- `planner.md`

### Keep only as archived reference

- `frontend.md`
- `android-specialist.md`

## Lowest-risk, highest-value import path

1. **Do not add new runtime agents yet.**
2. Use this mapping as the migration decision record.
3. If a later slice wants behavior imports, start with small prompt-level extractions only:
   - executor minimal-diff language from legacy `executor.md`
   - acceptance-criteria discipline from legacy `planner.md`
   - title/persistence guardrails from legacy `archivist.md` into wisdom/save-note flows
4. Treat `frontend.md` and `android-specialist.md` as design references for a future specialist QA lane only after Agmo defines a stable screenshot/preview capture contract.

## Implementation recommendation for this slice

The safest implementation for migration prep is this durable inventory file only. It records the mapping without changing runtime behavior or expanding the current native-agent contract prematurely.
