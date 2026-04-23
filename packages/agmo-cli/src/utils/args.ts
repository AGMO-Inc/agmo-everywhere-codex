import type { InstallScope } from "./paths.js";

export function parseScopeFlag(args: string[]): InstallScope {
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

  return "project";
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
