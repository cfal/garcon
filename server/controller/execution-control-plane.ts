export interface ExecutionControlPlaneStartup<T> {
  wireEvents(): T;
  startScheduledPrompts(): Promise<void>;
}

/** Installs terminal consumers before scheduled prompts can dispatch work. */
export async function startExecutionControlPlane<T>(
  startup: ExecutionControlPlaneStartup<T>,
): Promise<T> {
  const eventWiring = startup.wireEvents();
  await startup.startScheduledPrompts();
  return eventWiring;
}
