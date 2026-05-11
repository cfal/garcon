import { afterEach, describe, expect, it, mock } from 'bun:test';

const getPiModelsMock = mock(async () => []);

mock.module('../pi-models.js', () => ({
  getPiModels: getPiModelsMock,
}));

import { getPiAuthStatus } from '../pi-auth.js';

afterEach(() => {
  getPiModelsMock.mockReset();
  getPiModelsMock.mockImplementation(async () => []);
});

describe('Pi auth status', () => {
  it('is authenticated when SDK model discovery returns available models', async () => {
    getPiModelsMock.mockResolvedValueOnce([
      { value: 'openai/gpt-5.4', label: 'openai: gpt-5.4', supportsImages: true },
    ]);

    await expect(getPiAuthStatus()).resolves.toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });

  it('is disconnected when SDK model discovery returns no models', async () => {
    await expect(getPiAuthStatus()).resolves.toEqual({
      authenticated: false,
      canReauth: false,
      label: '',
    });
  });

  it('reports SDK model discovery failures as the auth label', async () => {
    getPiModelsMock.mockRejectedValueOnce(new Error('model registry failed'));

    await expect(getPiAuthStatus()).resolves.toEqual({
      authenticated: false,
      canReauth: false,
      label: 'model registry failed',
    });
  });
});
