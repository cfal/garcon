interface PiModelReader {
  getModels(): Promise<readonly unknown[]>;
}

export async function getPiAuthStatus(models: PiModelReader): Promise<{
  authenticated: boolean;
  canReauth: false;
  label: string;
}> {
  try {
    const availableModels = await models.getModels();
    return {
      authenticated: availableModels.length > 0,
      canReauth: false,
      label: '',
    };
  } catch (error) {
    return {
      authenticated: false,
      canReauth: false,
      label: error instanceof Error ? error.message : '',
    };
  }
}
