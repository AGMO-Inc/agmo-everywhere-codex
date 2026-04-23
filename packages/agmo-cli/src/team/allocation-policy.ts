export type TeamTask = {
  id: string;
  role?: string;
  owner?: string;
};

export function allocateTasksToWorkers(
  tasks: TeamTask[],
  workerCount: number
): TeamTask[] {
  return tasks.map((task, index) => ({
    ...task,
    owner: `worker-${(index % workerCount) + 1}`
  }));
}
