export function ensureCodexCliArgs(args: string[]): string[] {
  return args.includes("--yolo") ? args : ["--yolo", ...args];
}
