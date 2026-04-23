const DEFAULT_CODEX_AUTONOMY_FLAGS = ["--full-auto"] as const;
const LEGACY_CODEX_AUTONOMY_FLAGS = new Set(["--yolo"]);
const DANGEROUS_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

export function ensureCodexCliArgs(args: string[]): string[] {
  const passthroughArgs = args.filter((arg) => !LEGACY_CODEX_AUTONOMY_FLAGS.has(arg));

  if (
    passthroughArgs.includes(DANGEROUS_BYPASS_FLAG) ||
    passthroughArgs.includes(DEFAULT_CODEX_AUTONOMY_FLAGS[0])
  ) {
    return passthroughArgs;
  }

  return [...DEFAULT_CODEX_AUTONOMY_FLAGS, ...passthroughArgs];
}
