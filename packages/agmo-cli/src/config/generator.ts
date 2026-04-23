import { readFile } from "node:fs/promises";
import {
  agmoCliTemplateCandidatePaths,
  type InstallPaths,
  type InstallScope
} from "../utils/paths.js";
import {
  DEFAULT_AGMO_LAUNCH_POLICY,
  DEFAULT_AGMO_SESSION_START_POLICY,
  DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY
} from "./runtime.js";

export function buildAgmoConfigSummary(): Record<string, unknown> {
  return {
    outputs: [
      ".codex/agents/*.toml",
      ".codex/prompts/*.md",
      ".codex/hooks.json",
      "AGENTS.md",
      ".agmo/state/*",
      ".agmo/cache/session-instructions/*"
    ]
  };
}

export function buildAgmoRuntimeConfig(
  scope: InstallScope,
  paths: InstallPaths
): Record<string, unknown> {
  return {
    version: 1,
    generated_by: "agmo setup",
    generated_at: new Date().toISOString(),
    scope,
    paths: {
      codex_dir: paths.codexDir,
      agents_dir: paths.agentsDir,
      prompts_dir: paths.promptsDir,
      hooks_file: paths.hooksFile,
      agents_md_file: paths.agentsMdFile,
      agmo_dir: paths.agmoDir,
      state_dir: paths.stateDir,
      session_instructions_dir: paths.sessionInstructionsDir
    },
    launch: {
      default_cleanup_older_than_hours:
        DEFAULT_AGMO_LAUNCH_POLICY.default_cleanup_older_than_hours,
      heartbeat_stale_after_ms:
        DEFAULT_AGMO_LAUNCH_POLICY.heartbeat_stale_after_ms,
      heartbeat_interval_ms:
        DEFAULT_AGMO_LAUNCH_POLICY.heartbeat_interval_ms
    },
    session_start: {
      mode: DEFAULT_AGMO_SESSION_START_POLICY.mode,
      show_launch_policy_source:
        DEFAULT_AGMO_SESSION_START_POLICY.show_launch_policy_source
    },
    vault_autosave: {
      enabled: DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.enabled,
      on_stop: DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.on_stop,
      on_post_tool_use_success:
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.on_post_tool_use_success,
      on_workflow_change: DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.on_workflow_change,
      update_mode: DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.update_mode,
      append_section_title:
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.append_section_title,
      min_interval_ms: DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.min_interval_ms,
      append_max_entries: DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.append_max_entries,
      verification_history_limit:
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.verification_history_limit,
      dedupe_same_signature:
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.dedupe_same_signature,
      changed_file_ignore_prefixes: [
        ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.changed_file_ignore_prefixes
      ],
      changed_file_ignore_basenames: [
        ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.changed_file_ignore_basenames
      ],
      changed_file_ignore_segments: [
        ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.changed_file_ignore_segments
      ],
      template_files: { ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.template_files },
      title_patterns: { ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.title_patterns },
      workflow_types: { ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.workflow_types }
    }
  };
}

export async function loadAgentsTemplate(): Promise<string> {
  let lastError: unknown = null;
  for (const templatePath of agmoCliTemplateCandidatePaths("AGENTS.md")) {
    try {
      return await readFile(templatePath, "utf-8");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("AGENTS.md template not found in bundled template paths");
}
