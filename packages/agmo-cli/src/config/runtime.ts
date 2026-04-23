import { readTextFileIfExists, writeJsonFile } from "../utils/fs.js";
import { resolveInstallPaths, type InstallScope } from "../utils/paths.js";

export type AgmoLaunchPolicyConfig = {
  default_cleanup_older_than_hours?: number;
  heartbeat_stale_after_ms?: number;
  heartbeat_interval_ms?: number;
};

export type AgmoSessionStartPolicyConfig = {
  mode?: "compact" | "full" | "debug";
  show_launch_policy_source?: boolean;
};

export type AgmoVaultAutosaveUpdateMode = "overwrite" | "append-section";

export type AgmoVaultAutosavePolicyConfig = {
  enabled?: boolean;
  on_stop?: boolean;
  on_post_tool_use_success?: boolean;
  on_workflow_change?: boolean;
  update_mode?: AgmoVaultAutosaveUpdateMode;
  append_section_title?: string;
  min_interval_ms?: number;
  append_max_entries?: number;
  verification_history_limit?: number;
  dedupe_same_signature?: boolean;
  changed_file_ignore_prefixes?: string[];
  changed_file_ignore_basenames?: string[];
  changed_file_ignore_segments?: string[];
  template_files?: Record<string, string>;
  title_patterns?: Record<string, string>;
  workflow_enabled?: Record<string, boolean>;
  workflow_types?: Record<string, string>;
};

export type AgmoRuntimeConfig = {
  vault_root?: string;
  launch?: AgmoLaunchPolicyConfig;
  session_start?: AgmoSessionStartPolicyConfig;
  vault_autosave?: AgmoVaultAutosavePolicyConfig;
  [key: string]: unknown;
};

export const DEFAULT_AGMO_LAUNCH_POLICY: Required<AgmoLaunchPolicyConfig> = {
  default_cleanup_older_than_hours: 24,
  heartbeat_stale_after_ms: 2 * 60 * 1000,
  heartbeat_interval_ms: 30 * 1000
};

export const DEFAULT_AGMO_SESSION_START_POLICY: Required<AgmoSessionStartPolicyConfig> = {
  mode: "full",
  show_launch_policy_source: false
};

export const DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY: Required<
  Omit<AgmoVaultAutosavePolicyConfig, "workflow_enabled" | "workflow_types">
> & {
  workflow_enabled: Record<string, boolean>;
  workflow_types: Record<string, string>;
} = {
  enabled: true,
  on_stop: true,
  on_post_tool_use_success: true,
  on_workflow_change: true,
  update_mode: "overwrite",
  append_section_title: "Auto Checkpoints",
  min_interval_ms: 15_000,
  append_max_entries: 12,
  verification_history_limit: 5,
  dedupe_same_signature: true,
  changed_file_ignore_prefixes: [".agmo/", ".codex/"],
  changed_file_ignore_basenames: ["AGENTS.md", ".DS_Store"],
  changed_file_ignore_segments: [
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    "node_modules"
  ],
  template_files: {},
  title_patterns: {},
  workflow_enabled: {},
  workflow_types: {
    brainstorming: "design",
    plan: "plan",
    execute: "impl",
    verify: "memo",
    wisdom: "research",
    "vault-search": "research",
    "save-note": "memo",
    "git-workflow": "memo",
    "create-issue": "memo",
    "note-to-issue": "memo"
  }
};

async function readJsonFile<T>(path: string): Promise<T | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  return JSON.parse(content) as T;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeSessionStartMode(
  value: unknown
): "compact" | "full" | "debug" | undefined {
  return value === "compact" || value === "full" || value === "debug"
    ? value
    : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeVaultAutosaveUpdateMode(
  value: unknown
): AgmoVaultAutosaveUpdateMode | undefined {
  return value === "overwrite" || value === "append-section" ? value : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, entry]) => [key.trim(), typeof entry === "string" ? entry.trim() : ""] as const)
    .filter(([key, entry]) => key.length > 0 && entry.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeBooleanRecord(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, entry]) => [key.trim(), entry] as const)
    .filter(([key, entry]) => key.length > 0 && typeof entry === "boolean");

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

async function readAgmoConfig(path: string): Promise<AgmoRuntimeConfig> {
  return (await readJsonFile<AgmoRuntimeConfig>(path)) ?? {};
}

export async function readScopedAgmoConfig(
  scope: InstallScope,
  cwd = process.cwd()
): Promise<{
  scope: InstallScope;
  config_path: string;
  config: AgmoRuntimeConfig;
}> {
  const configPath = resolveInstallPaths(scope, cwd).agmoConfigFile;
  return {
    scope,
    config_path: configPath,
    config: await readAgmoConfig(configPath)
  };
}

export async function resolveLaunchPolicy(cwd = process.cwd()): Promise<{
  policy: Required<AgmoLaunchPolicyConfig>;
  sources: {
    project_config_path: string;
    user_config_path: string;
    effective: {
      default_cleanup_older_than_hours: "project" | "user" | "default";
      heartbeat_stale_after_ms: "project" | "user" | "default";
      heartbeat_interval_ms: "project" | "user" | "default";
    };
  };
}> {
  const projectConfigPath = resolveInstallPaths("project", cwd).agmoConfigFile;
  const userConfigPath = resolveInstallPaths("user", cwd).agmoConfigFile;
  const userConfig = await readAgmoConfig(userConfigPath);
  const projectConfig = await readAgmoConfig(projectConfigPath);
  const userLaunch = userConfig.launch ?? {};
  const projectLaunch = projectConfig.launch ?? {};
  const projectCleanup = normalizeNonNegativeNumber(
    projectLaunch.default_cleanup_older_than_hours
  );
  const userCleanup = normalizeNonNegativeNumber(
    userLaunch.default_cleanup_older_than_hours
  );
  const projectHeartbeatStale = normalizeNonNegativeNumber(
    projectLaunch.heartbeat_stale_after_ms
  );
  const userHeartbeatStale = normalizeNonNegativeNumber(
    userLaunch.heartbeat_stale_after_ms
  );
  const projectHeartbeatInterval = normalizeNonNegativeNumber(
    projectLaunch.heartbeat_interval_ms
  );
  const userHeartbeatInterval = normalizeNonNegativeNumber(
    userLaunch.heartbeat_interval_ms
  );

  return {
    policy: {
      default_cleanup_older_than_hours:
        projectCleanup ??
        userCleanup ??
        DEFAULT_AGMO_LAUNCH_POLICY.default_cleanup_older_than_hours,
      heartbeat_stale_after_ms:
        projectHeartbeatStale ??
        userHeartbeatStale ??
        DEFAULT_AGMO_LAUNCH_POLICY.heartbeat_stale_after_ms,
      heartbeat_interval_ms:
        projectHeartbeatInterval ??
        userHeartbeatInterval ??
        DEFAULT_AGMO_LAUNCH_POLICY.heartbeat_interval_ms
    },
    sources: {
      project_config_path: projectConfigPath,
      user_config_path: userConfigPath,
      effective: {
        default_cleanup_older_than_hours:
          projectCleanup !== undefined
            ? "project"
            : userCleanup !== undefined
              ? "user"
              : "default",
        heartbeat_stale_after_ms:
          projectHeartbeatStale !== undefined
            ? "project"
            : userHeartbeatStale !== undefined
              ? "user"
              : "default",
        heartbeat_interval_ms:
          projectHeartbeatInterval !== undefined
            ? "project"
            : userHeartbeatInterval !== undefined
              ? "user"
              : "default"
      }
    }
  };
}

export async function resolveSessionStartPolicy(cwd = process.cwd()): Promise<{
  policy: Required<AgmoSessionStartPolicyConfig>;
  sources: {
    project_config_path: string;
    user_config_path: string;
    effective: {
      mode: "project" | "user" | "default";
      show_launch_policy_source: "project" | "user" | "default";
    };
  };
}> {
  const projectConfigPath = resolveInstallPaths("project", cwd).agmoConfigFile;
  const userConfigPath = resolveInstallPaths("user", cwd).agmoConfigFile;
  const userConfig = await readAgmoConfig(userConfigPath);
  const projectConfig = await readAgmoConfig(projectConfigPath);
  const userSessionStart = userConfig.session_start ?? {};
  const projectSessionStart = projectConfig.session_start ?? {};
  const projectMode = normalizeSessionStartMode(projectSessionStart.mode);
  const userMode = normalizeSessionStartMode(userSessionStart.mode);
  const projectShowSource = normalizeBoolean(
    projectSessionStart.show_launch_policy_source
  );
  const userShowSource = normalizeBoolean(
    userSessionStart.show_launch_policy_source
  );

  return {
    policy: {
      mode: projectMode ?? userMode ?? DEFAULT_AGMO_SESSION_START_POLICY.mode,
      show_launch_policy_source:
        projectShowSource ??
        userShowSource ??
        DEFAULT_AGMO_SESSION_START_POLICY.show_launch_policy_source
    },
    sources: {
      project_config_path: projectConfigPath,
      user_config_path: userConfigPath,
      effective: {
        mode:
          projectMode !== undefined
            ? "project"
            : userMode !== undefined
              ? "user"
              : "default",
        show_launch_policy_source:
          projectShowSource !== undefined
            ? "project"
            : userShowSource !== undefined
              ? "user"
              : "default"
      }
    }
  };
}

export async function resolveVaultAutosavePolicy(cwd = process.cwd()): Promise<{
  policy: Required<
    Omit<AgmoVaultAutosavePolicyConfig, "workflow_enabled" | "workflow_types">
  > & {
    workflow_enabled: Record<string, boolean>;
    workflow_types: Record<string, string>;
  };
  sources: {
    project_config_path: string;
    user_config_path: string;
    effective: {
      enabled: "project" | "user" | "default";
      on_stop: "project" | "user" | "default";
      on_post_tool_use_success: "project" | "user" | "default";
      on_workflow_change: "project" | "user" | "default";
      update_mode: "project" | "user" | "default";
      append_section_title: "project" | "user" | "default";
      min_interval_ms: "project" | "user" | "default";
      append_max_entries: "project" | "user" | "default";
      verification_history_limit: "project" | "user" | "default";
      dedupe_same_signature: "project" | "user" | "default";
      changed_file_ignore_prefixes: "project" | "user" | "default";
      changed_file_ignore_basenames: "project" | "user" | "default";
      changed_file_ignore_segments: "project" | "user" | "default";
      template_files: "project" | "user" | "default";
      title_patterns: "project" | "user" | "default";
      workflow_enabled: "project" | "user" | "default";
      workflow_types: "project" | "user" | "default";
    };
  };
}> {
  const projectConfigPath = resolveInstallPaths("project", cwd).agmoConfigFile;
  const userConfigPath = resolveInstallPaths("user", cwd).agmoConfigFile;
  const userConfig = await readAgmoConfig(userConfigPath);
  const projectConfig = await readAgmoConfig(projectConfigPath);
  const userAutosave = userConfig.vault_autosave ?? {};
  const projectAutosave = projectConfig.vault_autosave ?? {};
  const projectEnabled = normalizeBoolean(projectAutosave.enabled);
  const userEnabled = normalizeBoolean(userAutosave.enabled);
  const projectOnStop = normalizeBoolean(projectAutosave.on_stop);
  const userOnStop = normalizeBoolean(userAutosave.on_stop);
  const projectOnPostToolSuccess = normalizeBoolean(
    projectAutosave.on_post_tool_use_success
  );
  const userOnPostToolSuccess = normalizeBoolean(userAutosave.on_post_tool_use_success);
  const projectOnWorkflowChange = normalizeBoolean(projectAutosave.on_workflow_change);
  const userOnWorkflowChange = normalizeBoolean(userAutosave.on_workflow_change);
  const projectUpdateMode = normalizeVaultAutosaveUpdateMode(projectAutosave.update_mode);
  const userUpdateMode = normalizeVaultAutosaveUpdateMode(userAutosave.update_mode);
  const projectAppendSectionTitle = normalizeNonEmptyString(
    projectAutosave.append_section_title
  );
  const userAppendSectionTitle = normalizeNonEmptyString(userAutosave.append_section_title);
  const projectMinIntervalMs = normalizeNonNegativeNumber(projectAutosave.min_interval_ms);
  const userMinIntervalMs = normalizeNonNegativeNumber(userAutosave.min_interval_ms);
  const projectAppendMaxEntries = normalizeNonNegativeNumber(
    projectAutosave.append_max_entries
  );
  const userAppendMaxEntries = normalizeNonNegativeNumber(userAutosave.append_max_entries);
  const projectVerificationHistoryLimit = normalizeNonNegativeNumber(
    projectAutosave.verification_history_limit
  );
  const userVerificationHistoryLimit = normalizeNonNegativeNumber(
    userAutosave.verification_history_limit
  );
  const projectDedupeSameSignature = normalizeBoolean(
    projectAutosave.dedupe_same_signature
  );
  const userDedupeSameSignature = normalizeBoolean(userAutosave.dedupe_same_signature);
  const projectIgnorePrefixes = normalizeStringArray(
    projectAutosave.changed_file_ignore_prefixes
  );
  const userIgnorePrefixes = normalizeStringArray(
    userAutosave.changed_file_ignore_prefixes
  );
  const projectIgnoreBasenames = normalizeStringArray(
    projectAutosave.changed_file_ignore_basenames
  );
  const userIgnoreBasenames = normalizeStringArray(
    userAutosave.changed_file_ignore_basenames
  );
  const projectIgnoreSegments = normalizeStringArray(
    projectAutosave.changed_file_ignore_segments
  );
  const userIgnoreSegments = normalizeStringArray(
    userAutosave.changed_file_ignore_segments
  );
  const projectTemplateFiles = normalizeStringRecord(projectAutosave.template_files);
  const userTemplateFiles = normalizeStringRecord(userAutosave.template_files);
  const projectTitlePatterns = normalizeStringRecord(projectAutosave.title_patterns);
  const userTitlePatterns = normalizeStringRecord(userAutosave.title_patterns);
  const userWorkflowEnabled = normalizeBooleanRecord(userAutosave.workflow_enabled);
  const projectWorkflowEnabled = normalizeBooleanRecord(projectAutosave.workflow_enabled);
  const userWorkflowTypes = normalizeStringRecord(userAutosave.workflow_types);
  const projectWorkflowTypes = normalizeStringRecord(projectAutosave.workflow_types);

  return {
    policy: {
      enabled: projectEnabled ?? userEnabled ?? DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.enabled,
      on_stop: projectOnStop ?? userOnStop ?? DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.on_stop,
      on_post_tool_use_success:
        projectOnPostToolSuccess ??
        userOnPostToolSuccess ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.on_post_tool_use_success,
      on_workflow_change:
        projectOnWorkflowChange ??
        userOnWorkflowChange ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.on_workflow_change,
      update_mode:
        projectUpdateMode ??
        userUpdateMode ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.update_mode,
      append_section_title:
        projectAppendSectionTitle ??
        userAppendSectionTitle ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.append_section_title,
      min_interval_ms:
        projectMinIntervalMs ??
        userMinIntervalMs ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.min_interval_ms,
      append_max_entries:
        projectAppendMaxEntries ??
        userAppendMaxEntries ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.append_max_entries,
      verification_history_limit:
        projectVerificationHistoryLimit ??
        userVerificationHistoryLimit ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.verification_history_limit,
      dedupe_same_signature:
        projectDedupeSameSignature ??
        userDedupeSameSignature ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.dedupe_same_signature,
      changed_file_ignore_prefixes:
        projectIgnorePrefixes ??
        userIgnorePrefixes ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.changed_file_ignore_prefixes,
      changed_file_ignore_basenames:
        projectIgnoreBasenames ??
        userIgnoreBasenames ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.changed_file_ignore_basenames,
      changed_file_ignore_segments:
        projectIgnoreSegments ??
        userIgnoreSegments ??
        DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.changed_file_ignore_segments,
      template_files: {
        ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.template_files,
        ...(userTemplateFiles ?? {}),
        ...(projectTemplateFiles ?? {})
      },
      title_patterns: {
        ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.title_patterns,
        ...(userTitlePatterns ?? {}),
        ...(projectTitlePatterns ?? {})
      },
      workflow_enabled: {
        ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.workflow_enabled,
        ...(userWorkflowEnabled ?? {}),
        ...(projectWorkflowEnabled ?? {})
      },
      workflow_types: {
        ...DEFAULT_AGMO_VAULT_AUTOSAVE_POLICY.workflow_types,
        ...(userWorkflowTypes ?? {}),
        ...(projectWorkflowTypes ?? {})
      }
    },
    sources: {
      project_config_path: projectConfigPath,
      user_config_path: userConfigPath,
      effective: {
        enabled:
          projectEnabled !== undefined
            ? "project"
            : userEnabled !== undefined
              ? "user"
              : "default",
        on_stop:
          projectOnStop !== undefined
            ? "project"
            : userOnStop !== undefined
              ? "user"
              : "default",
        on_post_tool_use_success:
          projectOnPostToolSuccess !== undefined
            ? "project"
            : userOnPostToolSuccess !== undefined
              ? "user"
              : "default",
        on_workflow_change:
          projectOnWorkflowChange !== undefined
            ? "project"
            : userOnWorkflowChange !== undefined
              ? "user"
              : "default",
        update_mode:
          projectUpdateMode !== undefined
            ? "project"
            : userUpdateMode !== undefined
              ? "user"
              : "default",
        append_section_title:
          projectAppendSectionTitle !== undefined
            ? "project"
            : userAppendSectionTitle !== undefined
              ? "user"
              : "default",
        min_interval_ms:
          projectMinIntervalMs !== undefined
            ? "project"
            : userMinIntervalMs !== undefined
              ? "user"
              : "default",
        append_max_entries:
          projectAppendMaxEntries !== undefined
            ? "project"
            : userAppendMaxEntries !== undefined
              ? "user"
              : "default",
        verification_history_limit:
          projectVerificationHistoryLimit !== undefined
            ? "project"
            : userVerificationHistoryLimit !== undefined
              ? "user"
              : "default",
        dedupe_same_signature:
          projectDedupeSameSignature !== undefined
            ? "project"
            : userDedupeSameSignature !== undefined
              ? "user"
              : "default",
        changed_file_ignore_prefixes:
          projectIgnorePrefixes !== undefined
            ? "project"
            : userIgnorePrefixes !== undefined
              ? "user"
              : "default",
        changed_file_ignore_basenames:
          projectIgnoreBasenames !== undefined
            ? "project"
            : userIgnoreBasenames !== undefined
              ? "user"
              : "default",
        changed_file_ignore_segments:
          projectIgnoreSegments !== undefined
            ? "project"
            : userIgnoreSegments !== undefined
              ? "user"
              : "default",
        template_files:
          projectTemplateFiles !== undefined
            ? "project"
            : userTemplateFiles !== undefined
              ? "user"
              : "default",
        title_patterns:
          projectTitlePatterns !== undefined
            ? "project"
            : userTitlePatterns !== undefined
              ? "user"
              : "default",
        workflow_enabled:
          projectWorkflowEnabled !== undefined
            ? "project"
            : userWorkflowEnabled !== undefined
              ? "user"
              : "default",
        workflow_types:
          projectWorkflowTypes !== undefined
            ? "project"
            : userWorkflowTypes !== undefined
              ? "user"
              : "default"
      }
    }
  };
}

export async function setLaunchPolicyValue(args: {
  key: keyof Required<AgmoLaunchPolicyConfig>;
  value: number;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key: keyof Required<AgmoLaunchPolicyConfig>;
  value: number;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    launch: {
      ...(scoped.config.launch ?? {}),
      [args.key]: args.value
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    key: args.key,
    value: args.value,
    config_path: scoped.config_path
  };
}

export async function unsetLaunchPolicyValue(args: {
  key: keyof Required<AgmoLaunchPolicyConfig>;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key: keyof Required<AgmoLaunchPolicyConfig>;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextLaunch = { ...(scoped.config.launch ?? {}) };
  delete nextLaunch[args.key];

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextLaunch).length > 0) {
    nextConfig.launch = nextLaunch;
  } else {
    delete nextConfig.launch;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    key: args.key,
    config_path: scoped.config_path
  };
}

export async function resetLaunchPolicy(args: {
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  delete nextConfig.launch;

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    config_path: scoped.config_path
  };
}

export async function setSessionStartPolicyValue(args: {
  key: keyof Required<AgmoSessionStartPolicyConfig>;
  value: "compact" | "full" | "debug" | boolean;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key: keyof Required<AgmoSessionStartPolicyConfig>;
  value: "compact" | "full" | "debug" | boolean;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    session_start: {
      ...(scoped.config.session_start ?? {}),
      [args.key]: args.value
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    key: args.key,
    value: args.value,
    config_path: scoped.config_path
  };
}

export async function unsetSessionStartPolicyValue(args: {
  key: keyof Required<AgmoSessionStartPolicyConfig>;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key: keyof Required<AgmoSessionStartPolicyConfig>;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextSessionStart = { ...(scoped.config.session_start ?? {}) };
  delete nextSessionStart[args.key];

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextSessionStart).length > 0) {
    nextConfig.session_start = nextSessionStart;
  } else {
    delete nextConfig.session_start;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    key: args.key,
    config_path: scoped.config_path
  };
}

export async function resetSessionStartPolicy(args: {
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  delete nextConfig.session_start;

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    config_path: scoped.config_path
  };
}

export async function setVaultAutosavePolicyValue(args: {
  key:
    | "enabled"
    | "on_stop"
    | "on_post_tool_use_success"
    | "on_workflow_change"
    | "update_mode"
    | "append_section_title"
    | "min_interval_ms"
    | "append_max_entries"
    | "verification_history_limit"
    | "dedupe_same_signature";
  value: boolean | AgmoVaultAutosaveUpdateMode | string | number;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key:
    | "enabled"
    | "on_stop"
    | "on_post_tool_use_success"
    | "on_workflow_change"
    | "update_mode"
    | "append_section_title"
    | "min_interval_ms"
    | "append_max_entries"
    | "verification_history_limit"
    | "dedupe_same_signature";
  value: boolean | AgmoVaultAutosaveUpdateMode | string | number;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    vault_autosave: {
      ...(scoped.config.vault_autosave ?? {}),
      [args.key]: args.value
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    key: args.key,
    value: args.value,
    config_path: scoped.config_path
  };
}

export async function setVaultAutosaveWorkflowType(args: {
  workflow: string;
  noteType: "plan" | "impl" | "design" | "research" | "meeting" | "memo";
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  workflow: string;
  note_type: "plan" | "impl" | "design" | "research" | "meeting" | "memo";
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    vault_autosave: {
      ...(scoped.config.vault_autosave ?? {}),
      workflow_types: {
        ...(scoped.config.vault_autosave?.workflow_types ?? {}),
        [args.workflow]: args.noteType
      }
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    workflow: args.workflow,
    note_type: args.noteType,
    config_path: scoped.config_path
  };
}

export async function setVaultAutosaveWorkflowEnabled(args: {
  workflow: string;
  enabled: boolean;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  workflow: string;
  enabled: boolean;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    vault_autosave: {
      ...(scoped.config.vault_autosave ?? {}),
      workflow_enabled: {
        ...(scoped.config.vault_autosave?.workflow_enabled ?? {}),
        [args.workflow]: args.enabled
      }
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    workflow: args.workflow,
    enabled: args.enabled,
    config_path: scoped.config_path
  };
}

export async function setVaultAutosaveStringList(args: {
  key:
    | "changed_file_ignore_prefixes"
    | "changed_file_ignore_basenames"
    | "changed_file_ignore_segments";
  value: string[];
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key:
    | "changed_file_ignore_prefixes"
    | "changed_file_ignore_basenames"
    | "changed_file_ignore_segments";
  value: string[];
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    vault_autosave: {
      ...(scoped.config.vault_autosave ?? {}),
      [args.key]: args.value
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    key: args.key,
    value: args.value,
    config_path: scoped.config_path
  };
}

export async function setVaultAutosaveTemplateFile(args: {
  noteType: "plan" | "impl" | "design" | "research" | "meeting" | "memo";
  path: string;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  note_type: "plan" | "impl" | "design" | "research" | "meeting" | "memo";
  path: string;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    vault_autosave: {
      ...(scoped.config.vault_autosave ?? {}),
      template_files: {
        ...(scoped.config.vault_autosave?.template_files ?? {}),
        [args.noteType]: args.path
      }
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    note_type: args.noteType,
    path: args.path,
    config_path: scoped.config_path
  };
}

export async function setVaultAutosaveTitlePattern(args: {
  workflow: string;
  pattern: string;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  workflow: string;
  pattern: string;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);

  await writeJsonFile(scoped.config_path, {
    ...scoped.config,
    vault_autosave: {
      ...(scoped.config.vault_autosave ?? {}),
      title_patterns: {
        ...(scoped.config.vault_autosave?.title_patterns ?? {}),
        [args.workflow]: args.pattern
      }
    },
    updated_at: new Date().toISOString()
  });

  return {
    scope: args.scope,
    workflow: args.workflow,
    pattern: args.pattern,
    config_path: scoped.config_path
  };
}

export async function unsetVaultAutosavePolicyValue(args: {
  key:
    | "enabled"
    | "on_stop"
    | "on_post_tool_use_success"
    | "on_workflow_change"
    | "update_mode"
    | "append_section_title"
    | "min_interval_ms"
    | "append_max_entries"
    | "verification_history_limit"
    | "dedupe_same_signature";
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key:
    | "enabled"
    | "on_stop"
    | "on_post_tool_use_success"
    | "on_workflow_change"
    | "update_mode"
    | "append_section_title"
    | "min_interval_ms"
    | "append_max_entries"
    | "verification_history_limit"
    | "dedupe_same_signature";
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextAutosave = { ...(scoped.config.vault_autosave ?? {}) };
  delete nextAutosave[args.key];

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextAutosave).length > 0) {
    nextConfig.vault_autosave = nextAutosave;
  } else {
    delete nextConfig.vault_autosave;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    key: args.key,
    config_path: scoped.config_path
  };
}

export async function unsetVaultAutosaveStringList(args: {
  key:
    | "changed_file_ignore_prefixes"
    | "changed_file_ignore_basenames"
    | "changed_file_ignore_segments";
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  key:
    | "changed_file_ignore_prefixes"
    | "changed_file_ignore_basenames"
    | "changed_file_ignore_segments";
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextAutosave = { ...(scoped.config.vault_autosave ?? {}) };
  delete nextAutosave[args.key];

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextAutosave).length > 0) {
    nextConfig.vault_autosave = nextAutosave;
  } else {
    delete nextConfig.vault_autosave;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    key: args.key,
    config_path: scoped.config_path
  };
}

export async function unsetVaultAutosaveWorkflowType(args: {
  workflow: string;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  workflow: string;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextWorkflowTypes = { ...(scoped.config.vault_autosave?.workflow_types ?? {}) };
  delete nextWorkflowTypes[args.workflow];

  const nextAutosave = { ...(scoped.config.vault_autosave ?? {}) };
  if (Object.keys(nextWorkflowTypes).length > 0) {
    nextAutosave.workflow_types = nextWorkflowTypes;
  } else {
    delete nextAutosave.workflow_types;
  }

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextAutosave).length > 0) {
    nextConfig.vault_autosave = nextAutosave;
  } else {
    delete nextConfig.vault_autosave;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    workflow: args.workflow,
    config_path: scoped.config_path
  };
}

export async function unsetVaultAutosaveWorkflowEnabled(args: {
  workflow: string;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  workflow: string;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextWorkflowEnabled = {
    ...(scoped.config.vault_autosave?.workflow_enabled ?? {})
  };
  delete nextWorkflowEnabled[args.workflow];

  const nextAutosave = { ...(scoped.config.vault_autosave ?? {}) };
  if (Object.keys(nextWorkflowEnabled).length > 0) {
    nextAutosave.workflow_enabled = nextWorkflowEnabled;
  } else {
    delete nextAutosave.workflow_enabled;
  }

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextAutosave).length > 0) {
    nextConfig.vault_autosave = nextAutosave;
  } else {
    delete nextConfig.vault_autosave;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    workflow: args.workflow,
    config_path: scoped.config_path
  };
}

export async function unsetVaultAutosaveTemplateFile(args: {
  noteType: string;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  note_type: string;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextTemplateFiles = { ...(scoped.config.vault_autosave?.template_files ?? {}) };
  delete nextTemplateFiles[args.noteType];

  const nextAutosave = { ...(scoped.config.vault_autosave ?? {}) };
  if (Object.keys(nextTemplateFiles).length > 0) {
    nextAutosave.template_files = nextTemplateFiles;
  } else {
    delete nextAutosave.template_files;
  }

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextAutosave).length > 0) {
    nextConfig.vault_autosave = nextAutosave;
  } else {
    delete nextConfig.vault_autosave;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    note_type: args.noteType,
    config_path: scoped.config_path
  };
}

export async function unsetVaultAutosaveTitlePattern(args: {
  workflow: string;
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  workflow: string;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextTitlePatterns = { ...(scoped.config.vault_autosave?.title_patterns ?? {}) };
  delete nextTitlePatterns[args.workflow];

  const nextAutosave = { ...(scoped.config.vault_autosave ?? {}) };
  if (Object.keys(nextTitlePatterns).length > 0) {
    nextAutosave.title_patterns = nextTitlePatterns;
  } else {
    delete nextAutosave.title_patterns;
  }

  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  if (Object.keys(nextAutosave).length > 0) {
    nextConfig.vault_autosave = nextAutosave;
  } else {
    delete nextConfig.vault_autosave;
  }

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    workflow: args.workflow,
    config_path: scoped.config_path
  };
}

export async function resetVaultAutosavePolicy(args: {
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  config_path: string;
}> {
  const cwd = args.cwd ?? process.cwd();
  const scoped = await readScopedAgmoConfig(args.scope, cwd);
  const nextConfig: AgmoRuntimeConfig = {
    ...scoped.config,
    updated_at: new Date().toISOString()
  };

  delete nextConfig.vault_autosave;

  await writeJsonFile(scoped.config_path, nextConfig);

  return {
    scope: args.scope,
    config_path: scoped.config_path
  };
}
