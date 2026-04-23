# Agmo AGENTS and Legacy Runtime Migration Plan

## Goal

Replace the remaining OMX-oriented contract surfaces with Agmo-native guidance, while preserving enough compatibility to avoid breaking active workflows during transition.

## Current State

- Managed Codex hooks already run through `agmo internal hook`.
- Wisdom memory is stored and loaded from `.agmo/memory/wisdom.json`.
- `doctor` now detects legacy `.omx` runtime directories and recommends `agmo setup migrate-legacy`.
- Several user-facing skill documents and the top-level `AGENTS.md` still describe OMX-era workflows and paths.

## Migration Principles

1. Prefer **Agmo-first wording** over OMX branding in user-facing docs.
2. Keep **legacy compatibility explicit** rather than implicit.
3. Move or archive legacy `.omx` runtime artifacts safely before deleting them.
4. Rewrite `AGENTS.md` only after the runtime and public skill surfaces are stable enough to support the new contract.

## Phases

### Phase 1 — User-facing surface cleanup

- Rewrite high-visibility skills (`help`, `doctor`, `hud`, `cancel`, `team`) to describe Agmo as the primary surface.
- Keep legacy `.omx` path mentions only where they are still operationally relevant.
- Remove stale oh-my-codex links and branding where they are no longer needed.

**Exit criteria**
- A new user can follow the skill docs without learning OMX terminology first.

### Phase 2 — Legacy runtime artifact migration

- Provide a safe command path to archive or remove `.omx` runtime directories.
- Default to archive, not delete.
- Surface migration guidance from `agmo doctor`.

**Exit criteria**
- Project/user `.omx` trees are no longer required for standard Agmo operation.

### Phase 3 — AGENTS contract replacement

- Replace OMX-centric routing and runtime wording in the root `AGENTS.md`.
- Preserve only the parts that still match the actual Agmo runtime.
- Remove or rename OMX-specific markers once runtime hooks no longer depend on them.

**Exit criteria**
- `AGENTS.md` reads as an Agmo contract first, with legacy notes isolated or removed.

### Phase 4 — Deep legacy skill/runtime retirement

- Audit remaining OMX-only skills (`autopilot`, `cancel`, `hud`, `worker`, notification flows, etc.).
- Decide per skill: migrate, archive, or delete.
- Remove unused `.omx` path handling from runtime code once no supported flow depends on it.

**Exit criteria**
- Remaining OMX references are either historical tests/fixtures or deliberately retained compatibility shims.

## Remaining High-Risk Areas

- `AGENTS.md` is still the largest OMX-oriented contract surface.
- Team/worker and cancel skills still reference legacy `.omx` state flows extensively.
- Some tests still use OMX strings as sample prompt content.

## Recommended Next Slice

1. Finish Agmo-first rewrites for the remaining high-visibility skills.
2. Run `agmo setup migrate-legacy --scope project` and `--scope user` on real environments after backup.
3. Draft an Agmo-native replacement for the root `AGENTS.md`, then validate it against current hook/runtime behavior before switching.
