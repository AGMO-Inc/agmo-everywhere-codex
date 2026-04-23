export const VAULT_AUTOSAVE_TEMPLATE_PLACEHOLDERS: Record<string, string> = {
  frontmatter: "Rendered YAML frontmatter block.",
  title: "Final note title.",
  project: "Project basename.",
  project_index: "Project index wikilink.",
  project_note_line: "Rendered project link callout line.",
  parent_line: "Rendered parent callout line when present.",
  parent_link: "Parent wikilink only.",
  workflow: "Current workflow name.",
  workflow_reason: "Detected workflow reason text.",
  trigger: "Autosave trigger name.",
  runtime_root: "Resolved runtime root path.",
  session_id: "Current session id.",
  last_event: "Latest recorded hook event.",
  updated_at: "Session updated timestamp.",
  started_at: "Session started timestamp.",
  completed_at: "Session completed timestamp.",
  prompt_excerpt: "Captured prompt excerpt.",
  current_focus: "Prompt excerpt reused for design/research style notes.",
  current_goal: "Prompt excerpt reused for plan notes.",
  planning_context: "Planning-oriented workflow reason.",
  decision_context: "Design-oriented workflow reason.",
  retrieval_context: "Research-oriented workflow reason.",
  next_signal: "Next verification signal / last event marker.",
  implementation_summary: "Short implementation summary line.",
  key_implementation_details: "Latest implementation/tool detail summary.",
  design_decisions: "Resolved parent or related design reference.",
  changed_files_bullets: "Markdown bullet list of changed files.",
  changed_files_table: "Markdown table of changed files.",
  verification_bullets: "Markdown bullet list of verification results.",
  verification_table: "Markdown table of verification results.",
  last_tool_name: "Latest tool name.",
  last_tool_status: "Latest tool status.",
  last_tool_summary: "Latest tool summary.",
  related_links_bullets: "Markdown bullet list of related links.",
  references_bullets: "Markdown bullet list of references/project links.",
  related_section: "Fully rendered related-links section.",
  summary_lines: "Markdown bullet lines for full session summary.",
  session_lines: "Markdown bullet lines for compact session summary.",
  append_section_title: "Configured append section title.",
  append_entry: "Rendered append entry block.",
  detail_section: "Fully rendered note-type specific detail section.",
  note_type: "Resolved vault note type."
};

export const VAULT_AUTOSAVE_TITLE_PATTERN_PLACEHOLDERS: Record<string, string> = {
  date: "ISO date (YYYY-MM-DD).",
  topic: "Sanitized prompt/topic summary.",
  workflow: "Current workflow name.",
  session_suffix: "Shortened session id suffix.",
  project: "Project basename.",
  note_type: "Resolved vault note type."
};

export function renderTemplateString(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    return values[key] ?? "";
  });
}

export function extractTemplatePlaceholders(template: string): string[] {
  const matches = template.match(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g) ?? [];
  return Array.from(
    new Set(
      matches.map((match) => match.replace(/[{}]/g, "").trim())
    )
  );
}

export function findUnknownTemplatePlaceholders(
  template: string,
  allowed: Record<string, string>
): string[] {
  const allowedKeys = new Set(Object.keys(allowed));
  return extractTemplatePlaceholders(template).filter((key) => !allowedKeys.has(key));
}

export function buildVaultAutosaveTemplatePreviewValues(noteType: string): Record<string, string> {
  return {
    frontmatter: [
      "---",
      `type: "${noteType}"`,
      'schema: "agmo-autosave-preview-v1"',
      'project: "demo-project"',
      'session_id: "preview-session"',
      'workflow: "execute"',
      'trigger: "stop"',
      "---",
      ""
    ].join("\n"),
    title: "2026-04-22 Preview Session",
    project: "demo-project",
    project_index: "[[demo-project/demo-project]]",
    project_note_line: "> 프로젝트: [[demo-project/demo-project]]",
    parent_line: "> Parent: [[demo-project/plans/[Plan] Preview Plan]]",
    parent_link: "[[demo-project/plans/[Plan] Preview Plan]]",
    workflow: "execute",
    workflow_reason: "implementation-oriented request",
    trigger: "stop",
    runtime_root: "/tmp/demo-project",
    session_id: "preview-session",
    last_event: "Stop",
    updated_at: "2026-04-22T10:00:00.000Z",
    started_at: "2026-04-22T09:58:00.000Z",
    completed_at: "2026-04-22T10:00:00.000Z",
    prompt_excerpt: "Preview prompt excerpt for autosave template rendering.",
    current_focus: "Preview prompt excerpt for autosave template rendering.",
    current_goal: "Preview goal for the checkpoint.",
    planning_context: "planning/decomposition-oriented request",
    decision_context: "brainstorming exploration request (or design alias)",
    retrieval_context: "knowledge retrieval request",
    next_signal: "PostToolUse",
    implementation_summary: "Agmo preview implementation summary.",
    key_implementation_details: "Latest tool output summary used for preview.",
    design_decisions: "[[demo-project/designs/[Design] Preview Design]]",
    changed_files_bullets: "- `src/example.ts`\n- `README.md`",
    changed_files_table: [
      "| 파일 | 변경 내용 |",
      "|------|----------|",
      "| `src/example.ts` | auto checkpoint detected change |",
      "| `README.md` | auto checkpoint detected change |"
    ].join("\n"),
    verification_bullets:
      "- [2026-04-22T09:59:00.000Z] pnpm check: succeeded — ok\n- [2026-04-22T09:59:30.000Z] pnpm build: succeeded — built",
    verification_table: [
      "| 검증 | 결과 |",
      "|------|------|",
      "| `2026-04-22T09:59:30.000Z` pnpm build | succeeded — built |",
      "| `2026-04-22T09:59:00.000Z` pnpm check | succeeded — ok |"
    ].join("\n"),
    last_tool_name: "pnpm build",
    last_tool_status: "succeeded",
    last_tool_summary: "built",
    related_links_bullets:
      "- [[demo-project/plans/[Plan] Preview Plan]]\n- [[demo-project/designs/[Design] Preview Design]]",
    references_bullets:
      "- [[demo-project/demo-project]]\n- [[demo-project/plans/[Plan] Preview Plan]]",
    related_section: [
      "## Related Links",
      "",
      "- [[demo-project/plans/[Plan] Preview Plan]]",
      "- [[demo-project/designs/[Design] Preview Design]]",
      ""
    ].join("\n"),
    summary_lines: [
      "- Runtime Root: /tmp/demo-project",
      "- Session ID: preview-session",
      "- Workflow: execute",
      "- Workflow Reason: implementation-oriented request",
      "- Last Event: Stop",
      "- Updated At: 2026-04-22T10:00:00.000Z",
      "- Started At: 2026-04-22T09:58:00.000Z",
      "- Completed At: 2026-04-22T10:00:00.000Z"
    ].join("\n"),
    session_lines: [
      "- Runtime Root: /tmp/demo-project",
      "- Session ID: preview-session",
      "- Workflow: execute",
      "- Workflow Reason: implementation-oriented request",
      "- Started At: 2026-04-22T09:58:00.000Z"
    ].join("\n"),
    append_section_title: "Auto Checkpoints",
    append_entry: "### 2026-04-22T10:00:00.000Z — stop\n\n- Implementation Focus: Preview goal",
    detail_section: "## Preview Detail\n\n- This is a rendered preview block.",
    note_type: noteType
  };
}
