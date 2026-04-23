import type { InstallScope } from "./paths.js";

export function parseOptionalScopeFlag(args: string[]): InstallScope | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--scope") {
      const value = args[index + 1];
      if (value === "project" || value === "user") {
        return value;
      }

      throw new Error("Expected --scope user|project");
    }

    if (arg === "--scope=project") {
      return "project";
    }

    if (arg === "--scope=user") {
      return "user";
    }
  }

  return null;
}

export function parseScopeFlag(args: string[]): InstallScope {
  const scope = parseOptionalScopeFlag(args);
  if (scope) {
    return scope;
  }

  return "project";
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
