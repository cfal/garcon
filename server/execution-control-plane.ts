export interface ExecutionControlPlaneStartup<T> {
  wireEvents(): T;
  recoverQueues(): Promise<void>;
  startScheduledPrompts(): Promise<void>;
}

/** Installs terminal consumers before any recovered producer can dispatch work. */
export async function startExecutionControlPlane<T>(
  startup: ExecutionControlPlaneStartup<T>,
): Promise<T> {
  const eventWiring = startup.wireEvents();
  await startup.recoverQueues();
  await startup.startScheduledPrompts();
  return eventWiring;
}
