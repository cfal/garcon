interface PiModelReader {
  getModelsStrict(signal?: AbortSignal): Promise<readonly unknown[]>;
}

export async function getPiAuthStatus(models: PiModelReader, signal?: AbortSignal): Promise<{
  authenticated: boolean;
  canReauth: false;
  label: string;
}> {
  try {
    const availableModels = await models.getModelsStrict(signal);
    return {
      authenticated: availableModels.length > 0,
      canReauth: false,
      label: '',
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {
      authenticated: false,
      canReauth: false,
      label: error instanceof Error ? error.message : '',
    };
  }
}
