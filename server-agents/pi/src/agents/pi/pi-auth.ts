import { getPiModels } from './pi-models.js';

export async function getPiAuthStatus(): Promise<{
  authenticated: boolean;
  canReauth: false;
  label: string;
}> {
  try {
    const models = await getPiModels();
    return {
      authenticated: models.length > 0,
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
