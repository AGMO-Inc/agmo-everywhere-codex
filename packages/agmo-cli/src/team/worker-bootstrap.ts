export function buildInitialWorkerInbox(input: {
  workerName: string;
  teamName: string;
  role: string;
  taskSummary: string;
  teamStateRoot: string;
  worktreePath: string;
  cliEntryPath?: string;
}): string {
  return `# Worker Assignment

Worker: ${input.workerName}
Team: ${input.teamName}
Role: ${input.role}

## Current assignment

${input.taskSummary}

## Runtime context

- Team state root: ${input.teamStateRoot}
- Worktree path: ${input.worktreePath}

## Operating rules

1. Read your worker status, heartbeat, and task files from the team state root.
2. Treat the worktree as your isolated workspace.
3. Keep updates durable and concise.
4. Do not edit another worker's assigned worktree.
${input.cliEntryPath ? `5. Report heartbeat with: node "${input.cliEntryPath}" team heartbeat ${input.teamName} ${input.workerName}` : ""}
`;
}

export function buildWorkerInstructions(input: {
  workerName: string;
  teamName: string;
  role: string;
  teamStateRoot: string;
  inboxPath: string;
  worktreePath: string;
  cliEntryPath?: string;
}): string {
  return `# Agmo Worker Runtime Instructions

Worker: ${input.workerName}
Team: ${input.teamName}
Role: ${input.role}

## Context

- Team state root: ${input.teamStateRoot}
- Inbox path: ${input.inboxPath}
- Worktree path: ${input.worktreePath}

## Rules

1. Read the inbox file first.
2. Treat the assigned role as your current operating lane.
3. Treat the worktree as your isolated workspace.
4. Persist status updates through runtime state files when the runtime implements them.
5. Do not edit another worker's worktree.
6. Focus on your assigned slice and leave orchestration to the leader.

## Runtime reporting

${input.cliEntryPath ? `- Heartbeat: \`node "${input.cliEntryPath}" team heartbeat ${input.teamName} ${input.workerName}\`` : "- Heartbeat command will be injected by runtime."}
${input.cliEntryPath ? `- Status report: \`node "${input.cliEntryPath}" team report ${input.teamName} ${input.workerName} working --task <task-id>\`` : "- Status reporting command will be injected by runtime."}
`;
}
