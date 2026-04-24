export type CodexAutonomyMode = "full-auto" | "madmax";

const DEFAULT_CODEX_AUTONOMY_FLAGS = ["--full-auto"] as const;
const LEGACY_CODEX_AUTONOMY_FLAGS = new Set(["--yolo"]);
const AGMO_MADMAX_FLAG = "--madmax";
const DANGEROUS_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

export function normalizeCodexAutonomyMode(value: unknown): CodexAutonomyMode | undefined {
  return value === "full-auto" || value === "madmax" ? value : undefined;
}

export function codexAutonomyFlagForMode(mode: CodexAutonomyMode): string {
  return mode === "madmax"
    ? DANGEROUS_BYPASS_FLAG
    : DEFAULT_CODEX_AUTONOMY_FLAGS[0];
}

export function ensureCodexCliArgs(
  args: string[],
  defaultAutonomyMode: CodexAutonomyMode = "full-auto"
): string[] {
  const passthroughArgs: string[] = [];
  let wantsMadmax = false;

  for (const arg of args) {
    if (LEGACY_CODEX_AUTONOMY_FLAGS.has(arg)) {
      continue;
    }

    if (arg === AGMO_MADMAX_FLAG) {
      wantsMadmax = true;
      continue;
    }

    passthroughArgs.push(arg);
  }

  if (
    passthroughArgs.includes(DANGEROUS_BYPASS_FLAG) ||
    passthroughArgs.includes(DEFAULT_CODEX_AUTONOMY_FLAGS[0])
  ) {
    return passthroughArgs;
  }

  return [wantsMadmax ? DANGEROUS_BYPASS_FLAG : codexAutonomyFlagForMode(defaultAutonomyMode), ...passthroughArgs];
}
