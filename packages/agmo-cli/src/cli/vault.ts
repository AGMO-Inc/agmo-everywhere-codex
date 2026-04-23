import { parseScopeFlag } from "../utils/args.js";
import { resolveRuntimeRoot } from "../utils/paths.js";
import {
  createVaultNote,
  renderVaultNoteScaffold,
  resolveVaultRoot,
  saveVaultNote,
  setVaultRoot,
  type VaultScaffoldInput,
  type VaultNoteType
} from "../vault/runtime.js";

function parseOption(args: string[], optionName: string): string | undefined {
  const exactIndex = args.findIndex((arg) => arg === optionName);
  if (exactIndex >= 0) {
    return args[exactIndex + 1];
  }

  const inline = args.find((arg) => arg.startsWith(`${optionName}=`));
  return inline ? inline.slice(optionName.length + 1) : undefined;
}

function parseCsvOption(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseKeyValueOptions(args: string[], optionName: string): Record<string, string> | undefined {
  const output: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    let raw: string | undefined;
    if (current === optionName) {
      raw = args[index + 1];
      index += 1;
    } else if (current.startsWith(`${optionName}=`)) {
      raw = current.slice(optionName.length + 1);
    }

    if (!raw) {
      continue;
    }

    const separatorIndex = raw.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
      throw new Error(`${optionName} must look like key=value`);
    }

    const key = raw.slice(0, separatorIndex).trim();
    const value = raw.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      throw new Error(`${optionName} must look like key=value`);
    }
    output[key] = value;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function parseScaffoldInput(args: string[]): VaultScaffoldInput {
  const type = parseOption(args, "--type");
  const project = parseOption(args, "--project");
  const title = parseOption(args, "--title");

  if (!type || !project || !title) {
    throw new Error(
      "missing required options: --type <type> --project <project> --title <title>"
    );
  }

  return {
    type: type as VaultNoteType,
    project,
    title,
    schema: parseOption(args, "--schema"),
    status: parseOption(args, "--status"),
    issue: parseOption(args, "--issue"),
    issueType: parseOption(args, "--issue-type"),
    pr: parseOption(args, "--pr"),
    plan: parseOption(args, "--plan"),
    date: parseOption(args, "--date"),
    attendees: parseCsvOption(parseOption(args, "--attendees")),
    aliases: parseCsvOption(parseOption(args, "--aliases")),
    tags: parseCsvOption(parseOption(args, "--tags")),
    parent: parseOption(args, "--parent"),
    related: parseCsvOption(parseOption(args, "--related")),
    templateFile: parseOption(args, "--template-file"),
    fields: parseKeyValueOptions(args, "--field")
  };
}

export async function runVaultCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const cwd = resolveRuntimeRoot();

  switch (subcommand) {
    case "config": {
      const action = args[1];
      if (action === "show") {
        const result = await resolveVaultRoot(cwd);
        console.log(JSON.stringify({ command: "vault config show", ...result }, null, 2));
        return;
      }

      if (action === "set-root") {
        const path = args[2];
        if (!path) {
          throw new Error("usage: agmo vault config set-root <path> [--scope user|project]");
        }
        const scope = parseScopeFlag(args.slice(3));
        const result = await setVaultRoot(path, scope, cwd);
        console.log(JSON.stringify({ command: "vault config set-root", ...result }, null, 2));
        return;
      }

      throw new Error(
        "usage: agmo vault config <show|set-root <path>> [--scope user|project]"
      );
    }
    case "save": {
      const type = parseOption(args.slice(1), "--type");
      const project = parseOption(args.slice(1), "--project");
      const title = parseOption(args.slice(1), "--title");
      const file = parseOption(args.slice(1), "--file");
      const index = args.slice(1).includes("--index");

      if (!type || !project || !title || !file) {
        throw new Error(
          "usage: agmo vault save --type <plan|impl|design|research|meeting|memo> --project <project> --title <title> --file <path> [--index]"
        );
      }

      const result = await saveVaultNote(
        {
          type: type as VaultNoteType,
          project,
          title,
          file,
          index
        },
        cwd
      );
      console.log(JSON.stringify({ command: "vault save", ...result }, null, 2));
      return;
    }
    case "scaffold": {
      const scaffold = await renderVaultNoteScaffold(parseScaffoldInput(args.slice(1)));
      const output = parseOption(args.slice(1), "--output");
      if (output) {
        const { writeTextFile } = await import("../utils/fs.js");
        const result = await writeTextFile(output, scaffold.content);
        console.log(
          JSON.stringify(
            {
              command: "vault scaffold",
              title: scaffold.title,
              output: result
            },
            null,
            2
          )
        );
      } else {
        process.stdout.write(scaffold.content);
      }
      return;
    }
    case "create": {
      const input = parseScaffoldInput(args.slice(1));
      const index = args.slice(1).includes("--index");
      const result = await createVaultNote(
        {
          ...input,
          index
        },
        cwd
      );
      console.log(
        JSON.stringify(
          {
            command: "vault create",
            ...result.vault,
            scaffold_title: result.scaffold.title
          },
          null,
          2
        )
      );
      return;
    }
    default:
      console.log(`Usage:
  agmo vault config show
  agmo vault config set-root <path> [--scope user|project]
  agmo vault save --type <plan|impl|design|research|meeting|memo> --project <project> --title <title> --file <path> [--index]
  agmo vault scaffold --type <plan|impl|design|research|meeting|memo> --project <project> --title <title> [--schema <name>] [--status <status>] [--issue <n>] [--issue-type <type>] [--pr <n>] [--plan <wikilink>] [--parent <wikilink>] [--related <a,b>] [--date <YYYY-MM-DD>] [--attendees <a,b>] [--aliases <a,b>] [--tags <a,b>] [--field key=value] [--template-file <path>] [--output <path>]
  agmo vault create --type <plan|impl|design|research|meeting|memo> --project <project> --title <title> [--schema <name>] [--status <status>] [--issue <n>] [--issue-type <type>] [--pr <n>] [--plan <wikilink>] [--parent <wikilink>] [--related <a,b>] [--date <YYYY-MM-DD>] [--attendees <a,b>] [--aliases <a,b>] [--tags <a,b>] [--field key=value] [--template-file <path>] [--index]`);
      process.exitCode = 1;
  }
}
