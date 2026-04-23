const DEFAULT_CODEX_AUTONOMY_FLAGS = ["--yolo", "--full-auto"] as const;

export function ensureCodexCliArgs(args: string[]): string[] {
  const autonomyFlags = new Set<string>(DEFAULT_CODEX_AUTONOMY_FLAGS);
  const passthroughArgs = args.filter((arg) => !autonomyFlags.has(arg));
  return [...DEFAULT_CODEX_AUTONOMY_FLAGS, ...passthroughArgs];
}
