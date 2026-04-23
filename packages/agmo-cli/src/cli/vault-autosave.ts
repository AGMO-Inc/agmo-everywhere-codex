import { execFile } from "node:child_process";
import {
  readScopedAgmoConfig,
  resetVaultAutosavePolicy,
  resolveVaultAutosavePolicy,
  setVaultAutosavePolicyValue,
  setVaultAutosaveStringList,
  setVaultAutosaveTemplateFile,
  setVaultAutosaveTitlePattern,
  setVaultAutosaveWorkflowEnabled,
  setVaultAutosaveWorkflowType,
  unsetVaultAutosavePolicyValue,
  unsetVaultAutosaveStringList,
  unsetVaultAutosaveTemplateFile,
  unsetVaultAutosaveTitlePattern,
  unsetVaultAutosaveWorkflowEnabled,
  unsetVaultAutosaveWorkflowType,
  type AgmoVaultAutosaveUpdateMode
} from "../config/runtime.js";
import { readTextFileIfExists, writeTextFile } from "../utils/fs.js";
import { parseScopeFlag } from "../utils/args.js";
import { agmoCliTemplateCandidatePaths, resolveRuntimeRoot } from "../utils/paths.js";
import { readPersistedSessionState, type SessionState } from "../hooks/runtime-state.js";
import {
  buildVaultAutosaveTemplatePreviewValues,
  extractTemplatePlaceholders,
  findUnknownTemplatePlaceholders,
  renderTemplateString,
  VAULT_AUTOSAVE_TEMPLATE_PLACEHOLDERS,
  VAULT_AUTOSAVE_TITLE_PATTERN_PLACEHOLDERS
} from "../vault/template-format.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function printVaultAutosaveHelp(): void {
  console.log(`Usage:
  agmo config vault-autosave show [--scope user|project]
  agmo config vault-autosave placeholders
  agmo config vault-autosave preview-template <note-type> [--session-id <id>]
  agmo config vault-autosave generate-docs [--output <path>]
  agmo config vault-autosave set <key> <value> [--scope user|project]
  agmo config vault-autosave unset <key> [--scope user|project]
  agmo config vault-autosave reset [--scope user|project]

Keys:
  enabled
  on_stop
  on_post_tool_use_success
  on_workflow_change
  update_mode
  append_section_title
  min_interval_ms
  append_max_entries
  verification_history_limit
  dedupe_same_signature
  changed_file_ignore_prefixes
  changed_file_ignore_basenames
  changed_file_ignore_segments
  workflow_enabled.<workflow>
  workflow_type.<workflow>
  template_file.<note-type>
  title_pattern.<workflow>

Examples:
  agmo config vault-autosave show
  agmo config vault-autosave set enabled true --scope project
  agmo config vault-autosave set update_mode append-section --scope project
  agmo config vault-autosave set append_section_title \"추가 체크포인트\" --scope project
  agmo config vault-autosave set min_interval_ms 15000 --scope project
  agmo config vault-autosave set append_max_entries 12 --scope project
  agmo config vault-autosave set verification_history_limit 5 --scope project
  agmo config vault-autosave set changed_file_ignore_prefixes \".agmo/,.codex/,.omx/\" --scope project
  agmo config vault-autosave set workflow_enabled.verify false --scope project
  agmo config vault-autosave set template_file.impl /path/to/template.md --scope project
  agmo config vault-autosave set title_pattern.execute \"{{date}} {{topic}} {{session_suffix}}\" --scope project
  agmo config vault-autosave set workflow_type.verify memo --scope project
  agmo config vault-autosave preview-template impl
  agmo config vault-autosave preview-template impl --session-id 019db32f-...
  agmo config vault-autosave generate-docs --output packages/agmo-cli/dist/templates/vault-autosave/SCHEMA.md
  agmo config vault-autosave unset append_section_title --scope project
  agmo config vault-autosave unset template_file.impl --scope project
  agmo config vault-autosave unset title_pattern.execute --scope project
  agmo config vault-autosave unset workflow_enabled.verify --scope project
  agmo config vault-autosave unset workflow_type.verify --scope project
  agmo config vault-autosave reset --scope project
`);
}

function parseBooleanValue(raw: string | undefined, flagName: string): boolean {
  if (!raw) {
    throw new Error(`missing value for ${flagName}`);
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${flagName} must be true|false`);
}

function parseAutosaveScalarKey(
  raw: string | undefined,
  usage: string
):
  | "enabled"
  | "on_stop"
  | "on_post_tool_use_success"
  | "on_workflow_change"
  | "update_mode"
  | "append_section_title"
  | "min_interval_ms"
  | "append_max_entries"
  | "verification_history_limit"
  | "dedupe_same_signature" {
  if (
    raw === "enabled" ||
    raw === "on_stop" ||
    raw === "on_post_tool_use_success" ||
    raw === "on_workflow_change" ||
    raw === "update_mode" ||
    raw === "append_section_title" ||
    raw === "min_interval_ms" ||
    raw === "append_max_entries" ||
    raw === "verification_history_limit" ||
    raw === "dedupe_same_signature"
  ) {
    return raw;
  }

  throw new Error(usage);
}

function parseWorkflowEnabledKey(raw: string | undefined): string | null {
  if (!raw?.startsWith("workflow_enabled.")) {
    return null;
  }

  const workflow = raw.slice("workflow_enabled.".length).trim();
  if (!workflow) {
    throw new Error("workflow_enabled key must include a workflow name");
  }

  return workflow;
}

function parseWorkflowTypeKey(raw: string | undefined): string | null {
  if (!raw?.startsWith("workflow_type.")) {
    return null;
  }

  const workflow = raw.slice("workflow_type.".length).trim();
  if (!workflow) {
    throw new Error("workflow_type key must include a workflow name");
  }

  return workflow;
}

function parseTemplateFileKey(
  raw: string | undefined
): "plan" | "impl" | "design" | "research" | "meeting" | "memo" | null {
  if (!raw?.startsWith("template_file.")) {
    return null;
  }

  return parseVaultNoteType(raw.slice("template_file.".length).trim());
}

function parseTitlePatternKey(raw: string | undefined): string | null {
  if (!raw?.startsWith("title_pattern.")) {
    return null;
  }

  const workflow = raw.slice("title_pattern.".length).trim();
  if (!workflow) {
    throw new Error("title_pattern key must include a workflow name");
  }

  return workflow;
}

function parseAutosaveUpdateMode(
  raw: string | undefined
): AgmoVaultAutosaveUpdateMode {
  if (raw === "overwrite" || raw === "append-section") {
    return raw;
  }

  throw new Error("<value> must be overwrite|append-section");
}

function parseVaultNoteType(
  raw: string | undefined
): "plan" | "impl" | "design" | "research" | "meeting" | "memo" {
  if (
    raw === "plan" ||
    raw === "impl" ||
    raw === "design" ||
    raw === "research" ||
    raw === "meeting" ||
    raw === "memo"
  ) {
    return raw;
  }

  throw new Error("<value> must be plan|impl|design|research|meeting|memo");
}

function parseNonNegativeNumber(raw: string | undefined, flagName: string): number {
  if (!raw) {
    throw new Error(`missing value for ${flagName}`);
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative number`);
  }

  return parsed;
}

function parseCsvListValue(raw: string | undefined, flagName: string): string[] {
  if (!raw) {
    throw new Error(`missing value for ${flagName}`);
  }

  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error(`${flagName} must contain at least one item`);
  }

  return values;
}

async function readResolvedTemplate(args: {
  noteType: "plan" | "impl" | "design" | "research" | "meeting" | "memo";
  projectRoot: string;
}): Promise<{
  template_path: string | null;
  source: "configured" | "builtin" | "missing";
  content: string | null;
}> {
  const effective = await resolveVaultAutosavePolicy(args.projectRoot);
  const configured = effective.policy.template_files[args.noteType];
  const paths = configured
    ? [configured]
    : agmoCliTemplateCandidatePaths("vault-autosave", `${args.noteType}.md`);

  for (const path of paths) {
    const content = await readTextFileIfExists(path);
    if (content !== null) {
      return {
        template_path: path,
        source: configured ? "configured" : "builtin",
        content
      };
    }
  }

  return {
    template_path: configured ?? null,
    source: "missing",
    content: null
  };
}

function parseOptionValue(args: string[], flag: string): string | null {
  const exactIndex = args.findIndex((entry) => entry === flag);
  if (exactIndex >= 0) {
    return args[exactIndex + 1] ?? null;
  }

  const inline = args.find((entry) => entry.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function sanitizePreviewTitle(value: string): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/[\/\\:*?"<>|]/g, "")
    .trim();
  return normalized || "Preview Title";
}

function renderPreviewTitle(args: {
  noteType: "plan" | "impl" | "design" | "research" | "meeting" | "memo";
  workflow: string;
  project: string;
  topic: string;
  sessionId: string;
  policy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"];
}): string {
  const { noteType, workflow, project, topic, sessionId, policy } = args;
  const pattern = policy.title_patterns[workflow];
  const suffix = sessionId.replace(/[^a-zA-Z0-9_-]+/g, "").slice(-8) || "session";
  if (!pattern) {
    return sanitizePreviewTitle(`2026-04-22 ${topic} ${suffix}`);
  }

  const rendered = sanitizePreviewTitle(
    renderTemplateString(pattern, {
      date: "2026-04-22",
      topic,
      workflow,
      session_suffix: suffix,
      project,
      note_type: noteType
    })
  );
  return rendered.includes(suffix) ? rendered : `${rendered} ${suffix}`;
}

async function buildDocsMarkdown(projectRoot: string): Promise<string> {
  const effective = await resolveVaultAutosavePolicy(projectRoot);
  const noteTypes: Array<"plan" | "impl" | "design" | "research" | "meeting" | "memo"> = [
    "plan",
    "impl",
    "design",
    "research",
    "meeting",
    "memo"
  ];

  const templateRows = await Promise.all(
    noteTypes.map(async (noteType) => {
      const resolved = await readResolvedTemplate({ noteType, projectRoot });
      return `| \`${noteType}\` | ${resolved.source} | ${resolved.template_path ?? "{missing}"} |`;
    })
  );

  const placeholderRows = Object.entries(VAULT_AUTOSAVE_TEMPLATE_PLACEHOLDERS).map(
    ([key, description]) => `| \`{{${key}}}\` | ${description} |`
  );
  const titleRows = Object.entries(VAULT_AUTOSAVE_TITLE_PATTERN_PLACEHOLDERS).map(
    ([key, description]) => `| \`{{${key}}}\` | ${description} |`
  );

  return [
    "# Agmo Vault Autosave Schema",
    "",
    "Auto-generated by `agmo config vault-autosave generate-docs`.",
    "",
    "## Effective Policy Snapshot",
    "",
    "```json",
    JSON.stringify(effective.policy, null, 2),
    "```",
    "",
    "## Built-in / Resolved Templates",
    "",
    "| Note Type | Source | Path |",
    "|-----------|--------|------|",
    ...templateRows,
    "",
    "## Template Placeholders",
    "",
    "| Placeholder | Description |",
    "|-------------|-------------|",
    ...placeholderRows,
    "",
    "## Title Pattern Placeholders",
    "",
    "| Placeholder | Description |",
    "|-------------|-------------|",
    ...titleRows,
    ""
  ].join("\n");
}

async function collectPreviewChangedFiles(args: {
  projectRoot: string;
  policy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"];
}): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--untracked-files=all"],
      { cwd: args.projectRoot }
    );
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.replace(/^[ MARCUD?!]{1,2}\s+/, "").trim().replace(/\\/g, "/"))
      .filter(Boolean)
      .filter((entry) => {
        const normalized = entry.replace(/^\.\/+/, "");
        if (!normalized) {
          return false;
        }
        if (args.policy.changed_file_ignore_basenames.includes(normalized)) {
          return false;
        }
        if (
          args.policy.changed_file_ignore_prefixes.some(
            (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
          )
        ) {
          return false;
        }
        const segments = normalized.split("/").filter(Boolean);
        return !segments.some((segment) =>
          args.policy.changed_file_ignore_segments.includes(segment)
        );
      })
      .slice(0, 20);
  } catch {
    return [];
  }
}

function renderPreviewChangedFilesTable(changedFiles: string[]): string {
  if (changedFiles.length === 0) {
    return ["| 파일 | 변경 내용 |", "|------|----------|", "| `{none}` | {변경 파일 없음} |"].join("\n");
  }

  return [
    "| 파일 | 변경 내용 |",
    "|------|----------|",
    ...changedFiles.map((entry) => `| \`${entry}\` | preview detected change |`)
  ].join("\n");
}

function renderPreviewVerificationTable(sessionState: SessionState | null): string {
  const history = sessionState?.verification_history ?? [];
  if (history.length === 0) {
    return ["| 검증 | 결과 |", "|------|------|", "| `{none}` | {검증 기록 없음} |"].join("\n");
  }

  return [
    "| 검증 | 결과 |",
    "|------|------|",
    ...history
      .slice(-5)
      .reverse()
      .map(
        (entry) =>
          `| \`${entry.recorded_at}\` ${entry.tool_name} | ${entry.tool_status}${entry.tool_summary ? ` — ${entry.tool_summary}` : ""} |`
      )
  ].join("\n");
}

export async function runVaultAutosaveCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printVaultAutosaveHelp();
    return;
  }

  const projectRoot = resolveRuntimeRoot();
  const action = args[0];

  if (action === "placeholders") {
    console.log(
      JSON.stringify(
        {
          command: "vault-autosave placeholders",
          template_placeholders: VAULT_AUTOSAVE_TEMPLATE_PLACEHOLDERS,
          title_pattern_placeholders: VAULT_AUTOSAVE_TITLE_PATTERN_PLACEHOLDERS
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "preview-template") {
    const noteType = parseVaultNoteType(args[1]);
    const resolved = await readResolvedTemplate({
      noteType,
      projectRoot
    });

    if (!resolved.content) {
      throw new Error(`template not found for note type: ${noteType}`);
    }

    const effective = await resolveVaultAutosavePolicy(projectRoot);
    const sessionId = parseOptionValue(args.slice(2), "--session-id");
    const persisted = sessionId
      ? await readPersistedSessionState({
          cwd: projectRoot,
          payload: { session_id: sessionId }
        })
      : null;
    const previewValues = buildVaultAutosaveTemplatePreviewValues(noteType);
    const workflow = persisted?.workflow ?? (noteType === "impl" ? "execute" : noteType);
    const project = projectRoot.split("/").filter(Boolean).at(-1) ?? "demo-project";
    const topic =
      (typeof persisted?.prompt_excerpt === "string" && persisted.prompt_excerpt.trim()) ||
      previewValues.current_focus;
    const changedFiles = persisted
      ? await collectPreviewChangedFiles({ projectRoot, policy: effective.policy })
      : [];
    const relatedNotes = Object.values(persisted?.autosave_notes ?? {}).filter(
      (entry) => entry.workflow !== workflow
    );
    const parent = relatedNotes.find((entry) => entry.workflow === "plan") ??
      relatedNotes.find((entry) => entry.workflow === "brainstorming") ??
      null;
    previewValues.workflow = workflow;
    previewValues.project = project;
    previewValues.project_index = `[[${project}/${project}]]`;
    previewValues.project_note_line = `> 프로젝트: [[${project}/${project}]]`;
    previewValues.parent_line = parent ? `> Parent: ${parent.wikilink}` : "";
    previewValues.parent_link = parent?.wikilink ?? "";
    previewValues.workflow_reason = persisted?.workflow_reason ?? previewValues.workflow_reason;
    previewValues.session_id = persisted?.session_id ?? sessionId ?? previewValues.session_id;
    previewValues.prompt_excerpt = persisted?.prompt_excerpt ?? previewValues.prompt_excerpt;
    previewValues.current_focus = persisted?.prompt_excerpt ?? previewValues.current_focus;
    previewValues.current_goal = persisted?.prompt_excerpt ?? previewValues.current_goal;
    previewValues.last_event = persisted?.last_event ?? previewValues.last_event;
    previewValues.updated_at = persisted?.updated_at ?? previewValues.updated_at;
    previewValues.started_at = persisted?.started_at ?? previewValues.started_at;
    previewValues.completed_at = persisted?.completed_at ?? previewValues.completed_at;
    previewValues.related_links_bullets =
      relatedNotes.length > 0
        ? relatedNotes.map((entry) => `- ${entry.wikilink}`).join("\n")
        : previewValues.related_links_bullets;
    previewValues.references_bullets =
      relatedNotes.length > 0
        ? [`- [[${project}/${project}]]`, ...relatedNotes.map((entry) => `- ${entry.wikilink}`)].join(
            "\n"
          )
        : previewValues.references_bullets;
    previewValues.changed_files_table =
      changedFiles.length > 0
        ? renderPreviewChangedFilesTable(changedFiles)
        : previewValues.changed_files_table;
    previewValues.changed_files_bullets =
      changedFiles.length > 0
        ? changedFiles.map((entry) => `- \`${entry}\``).join("\n")
        : previewValues.changed_files_bullets;
    previewValues.verification_table = renderPreviewVerificationTable(persisted);
    previewValues.verification_bullets =
      (persisted?.verification_history?.length ?? 0) > 0
        ? persisted!.verification_history!
            .slice(-5)
            .reverse()
            .map(
              (entry) =>
                `- [${entry.recorded_at}] ${entry.tool_name}: ${entry.tool_status}${entry.tool_summary ? ` — ${entry.tool_summary}` : ""}`
            )
            .join("\n")
        : previewValues.verification_bullets;
    previewValues.last_tool_name = persisted?.last_tool_name ?? previewValues.last_tool_name;
    previewValues.last_tool_status =
      persisted?.last_tool_status ?? previewValues.last_tool_status;
    previewValues.last_tool_summary =
      persisted?.last_tool_summary ?? previewValues.last_tool_summary;
    previewValues.design_decisions =
      parent?.wikilink ??
      relatedNotes.find((entry) => entry.type === "design")?.wikilink ??
      "Auto checkpoint preserved linked design/plan context.";
    previewValues.frontmatter = [
      "---",
      `type: \"${noteType}\"`,
      'schema: "agmo-autosave-preview-v1"',
      `project: \"${project}\"`,
      `session_id: \"${previewValues.session_id}\"`,
      `workflow: \"${workflow}\"`,
      'trigger: "preview"',
      "---",
      ""
    ].join("\n");
    previewValues.title = renderPreviewTitle({
      noteType,
      workflow,
      project,
      topic,
      sessionId: previewValues.session_id,
      policy: effective.policy
    });
    const unknown = findUnknownTemplatePlaceholders(
      resolved.content,
      VAULT_AUTOSAVE_TEMPLATE_PLACEHOLDERS
    );

    console.log(
      JSON.stringify(
        {
          command: "vault-autosave preview-template",
          note_type: noteType,
          template_path: resolved.template_path,
          source: resolved.source,
          session_based_preview: Boolean(persisted),
          session_id: sessionId,
          unknown_placeholders: unknown,
          placeholders_used: extractTemplatePlaceholders(resolved.content),
          rendered: renderTemplateString(resolved.content, previewValues)
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "generate-docs") {
    const outputPath = parseOptionValue(args.slice(1), "--output");
    const content = await buildDocsMarkdown(projectRoot);
    if (outputPath) {
      const result = await writeTextFile(outputPath, content);
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave generate-docs",
            output: result.path,
            status: result.status
          },
          null,
          2
        )
      );
      return;
    }

    process.stdout.write(`${content}\n`);
    return;
  }

  if (action === "show") {
    const configArgs = args.slice(1);
    const scope =
      configArgs.includes("--scope") || configArgs.some((arg) => arg.startsWith("--scope="))
        ? parseScopeFlag(configArgs)
        : null;

    if (scope) {
      const scoped = await readScopedAgmoConfig(scope, projectRoot);
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config show",
            mode: "scoped",
            scope,
            config_path: scoped.config_path,
            vault_autosave: scoped.config.vault_autosave ?? {}
          },
          null,
          2
        )
      );
      return;
    }

    console.log(
      JSON.stringify(
        {
          command: "vault-autosave config show",
          mode: "effective",
          ...(await resolveVaultAutosavePolicy(projectRoot))
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "set") {
    const rawKey = args[1];
    const workflowEnabled = parseWorkflowEnabledKey(rawKey);
    const workflow = parseWorkflowTypeKey(rawKey);
    const templateNoteType = parseTemplateFileKey(rawKey);
    const titlePatternWorkflow = parseTitlePatternKey(rawKey);
    const scope = parseScopeFlag(args.slice(3));

    if (workflowEnabled) {
      const result = await setVaultAutosaveWorkflowEnabled({
        workflow: workflowEnabled,
        enabled: parseBooleanValue(args[2], "<value>"),
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config set",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (workflow) {
      const result = await setVaultAutosaveWorkflowType({
        workflow,
        noteType: parseVaultNoteType(args[2]),
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config set",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (templateNoteType) {
      const templatePath = args[2]?.trim();
      if (!templatePath) {
        throw new Error("<value> must be a non-empty template file path");
      }
      const templateContent = await readTextFileIfExists(templatePath);
      if (templateContent === null) {
        throw new Error(`template file not found: ${templatePath}`);
      }
      const unknown = findUnknownTemplatePlaceholders(
        templateContent,
        VAULT_AUTOSAVE_TEMPLATE_PLACEHOLDERS
      );
      if (unknown.length > 0) {
        throw new Error(`unknown template placeholders: ${unknown.join(", ")}`);
      }
      const result = await setVaultAutosaveTemplateFile({
        noteType: templateNoteType,
        path: templatePath,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config set",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (titlePatternWorkflow) {
      const pattern = args[2]?.trim();
      if (!pattern) {
        throw new Error("<value> must be a non-empty title pattern");
      }
      const unknown = findUnknownTemplatePlaceholders(
        pattern,
        VAULT_AUTOSAVE_TITLE_PATTERN_PLACEHOLDERS
      );
      if (unknown.length > 0) {
        throw new Error(`unknown title pattern placeholders: ${unknown.join(", ")}`);
      }
      const result = await setVaultAutosaveTitlePattern({
        workflow: titlePatternWorkflow,
        pattern,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config set",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (
      rawKey === "changed_file_ignore_prefixes" ||
      rawKey === "changed_file_ignore_basenames" ||
      rawKey === "changed_file_ignore_segments"
    ) {
      const result = await setVaultAutosaveStringList({
        key: rawKey,
        value: parseCsvListValue(args[2], "<value>"),
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config set",
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    const key = parseAutosaveScalarKey(
      rawKey,
      "usage: agmo config vault-autosave set <enabled|on_stop|on_post_tool_use_success|on_workflow_change|update_mode|append_section_title|min_interval_ms|append_max_entries|verification_history_limit|dedupe_same_signature|changed_file_ignore_prefixes|changed_file_ignore_basenames|changed_file_ignore_segments|workflow_enabled.<workflow>|workflow_type.<workflow>|template_file.<note-type>> <value> [--scope user|project]"
    );
    const value =
      key === "update_mode"
        ? parseAutosaveUpdateMode(args[2])
        : key === "min_interval_ms" ||
            key === "append_max_entries" ||
            key === "verification_history_limit"
          ? parseNonNegativeNumber(args[2], "<value>")
          : key === "append_section_title"
            ? (args[2]?.trim()
                ? args[2].trim()
                : (() => {
                    throw new Error("<value> must be a non-empty string");
                  })())
            : parseBooleanValue(args[2], "<value>");

    const result = await setVaultAutosavePolicyValue({
      key,
      value,
      scope,
      cwd: projectRoot
    });
    console.log(
      JSON.stringify(
        {
          command: "vault-autosave config set",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "unset") {
    const rawKey = args[1];
    const workflowEnabled = parseWorkflowEnabledKey(rawKey);
    const workflow = parseWorkflowTypeKey(rawKey);
    const templateNoteType = parseTemplateFileKey(rawKey);
    const titlePatternWorkflow = parseTitlePatternKey(rawKey);
    const scope = parseScopeFlag(args.slice(2));

    if (workflowEnabled) {
      const result = await unsetVaultAutosaveWorkflowEnabled({
        workflow: workflowEnabled,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config unset",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (workflow) {
      const result = await unsetVaultAutosaveWorkflowType({
        workflow,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config unset",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (templateNoteType) {
      const result = await unsetVaultAutosaveTemplateFile({
        noteType: templateNoteType,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config unset",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (titlePatternWorkflow) {
      const result = await unsetVaultAutosaveTitlePattern({
        workflow: titlePatternWorkflow,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config unset",
            key: rawKey,
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (
      rawKey === "changed_file_ignore_prefixes" ||
      rawKey === "changed_file_ignore_basenames" ||
      rawKey === "changed_file_ignore_segments"
    ) {
      const result = await unsetVaultAutosaveStringList({
        key: rawKey,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "vault-autosave config unset",
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    const key = parseAutosaveScalarKey(
      rawKey,
      "usage: agmo config vault-autosave unset <enabled|on_stop|on_post_tool_use_success|on_workflow_change|update_mode|append_section_title|min_interval_ms|append_max_entries|verification_history_limit|dedupe_same_signature|changed_file_ignore_prefixes|changed_file_ignore_basenames|changed_file_ignore_segments|workflow_enabled.<workflow>|workflow_type.<workflow>|template_file.<note-type>> [--scope user|project]"
    );
    const result = await unsetVaultAutosavePolicyValue({
      key,
      scope,
      cwd: projectRoot
    });
    console.log(
      JSON.stringify(
        {
          command: "vault-autosave config unset",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "reset") {
    const scope = parseScopeFlag(args.slice(1));
    const result = await resetVaultAutosavePolicy({
      scope,
      cwd: projectRoot
    });
    console.log(
      JSON.stringify(
        {
          command: "vault-autosave config reset",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  throw new Error(
    "usage: agmo config vault-autosave <show [--scope user|project]|set <key> <value> [--scope user|project]|unset <key> [--scope user|project]|reset [--scope user|project]>"
  );
}
