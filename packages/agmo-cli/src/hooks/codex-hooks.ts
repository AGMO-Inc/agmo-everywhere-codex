export const AGMO_MANAGED_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop"
] as const;

type HookCommand = {
  type: "command";
  command: string;
  statusMessage?: string;
  timeout?: number;
};

type HookEntry = {
  matcher?: string;
  hooks: HookCommand[];
};

type HooksConfig = {
  hooks?: Record<string, HookEntry[]>;
};

type HookPayload = Record<string, unknown>;

function buildEntry(
  command: string,
  options: {
    matcher?: string;
    statusMessage?: string;
    timeout?: number;
  } = {}
): HookEntry {
  return {
    ...(options.matcher ? { matcher: options.matcher } : {}),
    hooks: [
      {
        type: "command",
        command,
        ...(options.statusMessage
          ? { statusMessage: options.statusMessage }
          : {}),
        ...(typeof options.timeout === "number"
          ? { timeout: options.timeout }
          : {})
      }
    ]
  };
}

export function buildHookCommand(
  cliEntryPath: string,
  scope?: "project" | "user"
): string {
  return `node "${cliEntryPath}" internal hook${scope ? ` --scope ${scope}` : ""}`;
}

export function buildManagedHooksConfig(command: string): HooksConfig {
  return {
    hooks: {
      SessionStart: [
        buildEntry(command, {
          matcher: "startup|resume"
        })
      ],
      PreToolUse: [
        buildEntry(command, {
          matcher: "Bash",
          statusMessage: "Running Agmo Bash preflight"
        })
      ],
      PostToolUse: [
        buildEntry(command, {
          statusMessage: "Running Agmo post-tool review"
        })
      ],
      UserPromptSubmit: [
        buildEntry(command, {
          statusMessage: "Applying Agmo workflow routing"
        })
      ],
      Stop: [
        buildEntry(command, {
          timeout: 30
        })
      ]
    }
  };
}

function parseHooksConfig(content: string | null): HooksConfig {
  if (!content) {
    return {};
  }

  try {
    const parsed = JSON.parse(content) as HooksConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function isManagedCommand(command: string): boolean {
  return /\bnode\s+(?:"[^"]*agmo[^"]*[\\/]dist[\\/]cli[\\/]index\.js"|\S*agmo\S*[\\/]dist[\\/]cli[\\/]index\.js)\s+internal\s+hook\b/i.test(
    command
  );
}

function isLegacyManagedCommand(command: string): boolean {
  return /codex-native-hook\.js/.test(command);
}

function stripManagedHooks(entries: HookEntry[] | undefined): HookEntry[] {
  if (!entries) {
    return [];
  }

  return entries
    .map((entry) => {
      const nextHooks = entry.hooks.filter(
        (hook) =>
          !(
            hook.type === "command" &&
            (isManagedCommand(hook.command) || isLegacyManagedCommand(hook.command))
          )
      );

      if (nextHooks.length === 0) {
        return null;
      }

      return {
        ...entry,
        hooks: nextHooks
      };
    })
    .filter((entry): entry is HookEntry => entry !== null);
}

function payloadString(payload: HookPayload, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function matcherApplies(
  eventName: string,
  matcher: string | undefined,
  payload: HookPayload
): boolean {
  if (!matcher) {
    return true;
  }
  if (matcher === "*") {
    return true;
  }

  const candidate =
    eventName === "SessionStart"
      ? payloadString(payload, "source", "session_start_source", "sessionStartSource")
      : eventName === "PreToolUse" || eventName === "PostToolUse"
        ? payloadString(payload, "tool_name", "toolName", "tool")
        : "";
  if (!candidate) {
    return false;
  }

  try {
    return new RegExp(`^(?:${matcher})$`, "i").test(candidate);
  } catch {
    return false;
  }
}

export function managedProjectHookApplies(
  existingContent: string | null,
  eventName: string,
  payload: HookPayload
): boolean {
  const config = parseHooksConfig(existingContent);
  const entries = config.hooks?.[eventName];
  if (!Array.isArray(entries)) {
    return false;
  }

  return entries.some((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const candidate = entry as { matcher?: unknown; hooks?: unknown };
    if (
      candidate.matcher !== undefined &&
      typeof candidate.matcher !== "string"
    ) {
      return false;
    }
    if (
      !matcherApplies(eventName, candidate.matcher as string | undefined, payload) ||
      !Array.isArray(candidate.hooks)
    ) {
      return false;
    }

    return candidate.hooks.some((hook: unknown) => {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
        return false;
      }
      const command = hook as { type?: unknown; command?: unknown };
      return (
        command.type === "command" &&
        typeof command.command === "string" &&
        isManagedCommand(command.command) &&
        /(?:^|\s)--scope(?:=|\s+)project(?:\s|$)/.test(command.command)
      );
    });
  });
}

export function mergeManagedHooksConfig(
  existingContent: string | null,
  command: string
): string {
  const existing = parseHooksConfig(existingContent);
  const managed = buildManagedHooksConfig(command);
  const nextHooks: Record<string, HookEntry[]> = {
    ...(existing.hooks ?? {})
  };

  for (const eventName of AGMO_MANAGED_HOOK_EVENTS) {
    const preserved = stripManagedHooks(nextHooks[eventName]);
    const replacements = managed.hooks?.[eventName] ?? [];
    nextHooks[eventName] = [...preserved, ...replacements];
  }

  return `${JSON.stringify({ ...(existing ?? {}), hooks: nextHooks }, null, 2)}\n`;
}
