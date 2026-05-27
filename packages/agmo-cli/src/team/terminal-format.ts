export type AgmoColorMode = "auto" | "always" | "never";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m"
} as const;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function visibleLength(value: string): number {
  return Array.from(stripAnsi(value)).length;
}

export function sanitizeTerminalText(value: unknown): string {
  return String(value ?? "")
    .replace(CONTROL_PATTERN, "?")
    .replace(/\r/g, "")
    .replace(/\t/g, " ");
}

export function resolveColorEnabled(
  mode: AgmoColorMode = "auto",
  env: NodeJS.ProcessEnv = process.env,
  stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout
): boolean {
  if (mode === "always") {
    return true;
  }
  if (mode === "never") {
    return false;
  }
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === "0") {
    return false;
  }
  return Boolean(stream.isTTY);
}

export function colorize(value: string, color: keyof typeof SGR, enabled: boolean): string {
  if (!enabled) {
    return value;
  }
  return `${SGR[color]}${value}${SGR.reset}`;
}

export function ellipsize(value: string, maxWidth: number, sanitizeInput = true): string {
  const sanitized = sanitizeInput ? sanitizeTerminalText(value) : value;
  if (maxWidth <= 0) {
    return "";
  }
  if (visibleLength(sanitized) <= maxWidth) {
    return sanitized;
  }
  if (maxWidth === 1) {
    return ".";
  }
  return `${Array.from(stripAnsi(sanitized)).slice(0, maxWidth - 1).join("")}.`;
}

export function wrapLine(value: string, maxWidth: number, sanitizeInput = true): string[] {
  const sanitized = sanitizeInput ? sanitizeTerminalText(value) : value;
  if (maxWidth <= 0) {
    return [""];
  }
  if (visibleLength(sanitized) <= maxWidth) {
    return [sanitized];
  }

  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (visibleLength(word) > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      const chars = Array.from(word);
      for (let index = 0; index < chars.length; index += maxWidth) {
        lines.push(chars.slice(index, index + maxWidth).join(""));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (visibleLength(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

export function fitLines(lines: string[], maxWidth: number, maxLines?: number): string[] {
  const wrapped = lines.flatMap((line) => wrapLine(line, maxWidth, false));
  if (!maxLines || maxLines < 1 || wrapped.length <= maxLines) {
    return wrapped.map((line) => ellipsize(line, maxWidth, false));
  }
  const kept = wrapped.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize("... clipped", maxWidth, false);
  return kept.map((line) => ellipsize(line, maxWidth, false));
}
