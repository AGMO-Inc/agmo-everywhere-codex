# Agmo Vault Autosave Templates

Built-in autosave templates live here and are copied to `dist/templates/vault-autosave` during `pnpm --filter agmo build`.

## Preview

```bash
agmo config vault-autosave preview-template impl
agmo config vault-autosave preview-template design
agmo config vault-autosave preview-template impl --session-id 019db32f-...
agmo config vault-autosave generate-docs --output packages/agmo-cli/dist/templates/vault-autosave/SCHEMA.md
```

## Placeholder reference

Show the machine-readable placeholder catalog:

```bash
agmo config vault-autosave placeholders
```

Common placeholders:

- `{{frontmatter}}`
- `{{title}}`
- `{{project_note_line}}`
- `{{parent_line}}`
- `{{prompt_excerpt}}`
- `{{summary_lines}}`
- `{{related_links_bullets}}`
- `{{changed_files_table}}`
- `{{verification_table}}`
- `{{detail_section}}`

## Custom template override

```bash
agmo config vault-autosave set template_file.impl /path/to/impl-template.md --scope project
agmo config vault-autosave unset template_file.impl --scope project
```

Unknown placeholders are rejected when setting a custom template file.

## Generated schema docs

Builds now generate:

- `dist/templates/vault-autosave/SCHEMA.md`

You can regenerate manually:

```bash
agmo config vault-autosave generate-docs --output packages/agmo-cli/dist/templates/vault-autosave/SCHEMA.md
```

## Workflow title patterns

Title rules can be customized per workflow:

```bash
agmo config vault-autosave set title_pattern.execute "{{date}} {{topic}} {{session_suffix}}" --scope project
agmo config vault-autosave unset title_pattern.execute --scope project
```

Supported title placeholders:

- `{{date}}`
- `{{topic}}`
- `{{workflow}}`
- `{{session_suffix}}`
- `{{project}}`
- `{{note_type}}`

## Workflow-specific autosave toggles

You can disable autosave for specific workflows without turning the whole feature off:

```bash
agmo config vault-autosave set workflow_enabled.verify false --scope project
agmo config vault-autosave unset workflow_enabled.verify --scope project
```

This is useful when a canonical vault should keep durable implementation or planning notes but skip transient verification checkpoints.
