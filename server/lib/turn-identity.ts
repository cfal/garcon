export interface TurnIdentity {
  clientRequestId?: string;
  turnId?: string;
}

export function matchesTurnIdentity(
  expected: TurnIdentity | undefined,
  actual: TurnIdentity | undefined,
): boolean {
  if (expected?.turnId) return actual?.turnId === expected.turnId;
  if (expected?.clientRequestId) return actual?.clientRequestId === expected.clientRequestId;
  return !actual?.turnId && !actual?.clientRequestId;
}
