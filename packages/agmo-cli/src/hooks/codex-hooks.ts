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

export function buildHookCommand(cliEntryPath: string): string {
  return `node "${cliEntryPath}" internal hook`;
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
  return /\binternal hook\b/.test(command);
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
