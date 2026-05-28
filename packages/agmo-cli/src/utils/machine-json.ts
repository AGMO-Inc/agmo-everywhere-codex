export const AGMO_MACHINE_JSON_SCHEMA_VERSION = "1.0";

export type MachineJsonEnvelope = {
  schema_version: typeof AGMO_MACHINE_JSON_SCHEMA_VERSION;
  operation: string;
  ok: boolean;
};

export function machineJsonEnvelope<T extends Record<string, unknown>>(
  operation: string,
  ok: boolean,
  payload: T
): MachineJsonEnvelope & T {
  return {
    schema_version: AGMO_MACHINE_JSON_SCHEMA_VERSION,
    operation,
    ok,
    ...payload
  };
}

export function uniqueRecommendedActions(
  actions: Array<string | undefined | null>
): string[] {
  return [...new Set(actions.filter((action): action is string => Boolean(action)))];
}
