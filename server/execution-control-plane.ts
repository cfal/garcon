export interface ExecutionControlPlaneStartup<T> {
  wireEvents(): T;
  recoverControls(): Promise<void>;
  activateRecoveredSettlement(): Promise<void>;
  startScheduledPrompts(): Promise<void>;
}

/** Installs terminal consumers before any recovered producer can dispatch work. */
export async function startExecutionControlPlane<T>(
  startup: ExecutionControlPlaneStartup<T>,
): Promise<T> {
  const eventWiring = startup.wireEvents();
  await startup.recoverControls();
  await startup.activateRecoveredSettlement();
  await startup.startScheduledPrompts();
  return eventWiring;
}
