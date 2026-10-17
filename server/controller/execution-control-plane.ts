export interface ExecutionControlPlaneStartup<T> {
  wireEvents(): T;
  // Starts the controller's own dispatchers: scheduled prompts and pull request reviews.
  startDispatchers(): Promise<void>;
}

/** Installs terminal consumers before the controller's dispatchers can start work. */
export async function startExecutionControlPlane<T>(
  startup: ExecutionControlPlaneStartup<T>,
): Promise<T> {
  const eventWiring = startup.wireEvents();
  await startup.startDispatchers();
  return eventWiring;
}
