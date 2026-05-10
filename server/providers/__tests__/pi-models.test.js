import { afterEach, describe, expect, it, mock } from 'bun:test';

import { PI_MODELS } from '../../../common/models.js';

const createAgentSessionServicesMock = mock(async () => ({
  modelRegistry: { getAvailable: () => [] },
}));
const authStorageCreateMock = mock(() => ({}));
const getAgentDirMock = mock(() => '/tmp/pi-agent');

mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: authStorageCreateMock },
  createAgentSessionServices: createAgentSessionServicesMock,
  getAgentDir: getAgentDirMock,
}));

import { clearPiModelCacheForTests, getPiAvailableModels, getPiModels } from '../pi-models.js';

afterEach(() => {
  createAgentSessionServicesMock.mockReset();
  createAgentSessionServicesMock.mockImplementation(async () => ({
    modelRegistry: { getAvailable: () => [] },
  }));
  authStorageCreateMock.mockReset();
  authStorageCreateMock.mockImplementation(() => ({}));
  getAgentDirMock.mockReset();
  getAgentDirMock.mockImplementation(() => '/tmp/pi-agent');
  clearPiModelCacheForTests();
});

describe('Pi model discovery', () => {
  it('prepends the default fallback to dynamically discovered SDK models', async () => {
    createAgentSessionServicesMock.mockResolvedValueOnce({
      modelRegistry: {
        getAvailable: () => [
          {
            provider: 'openai',
            id: 'gpt-5.4',
            input: ['text', 'image'],
          },
        ],
      },
    });

    await expect(getPiModels()).resolves.toEqual([
      ...PI_MODELS.OPTIONS,
      { value: 'openai/gpt-5.4', label: 'openai/gpt-5.4', supportsImages: true },
    ]);
  });

  it('returns SDK-discovered models without the static default option', async () => {
    createAgentSessionServicesMock.mockResolvedValueOnce({
      modelRegistry: {
        getAvailable: () => [
          {
            provider: 'openai',
            id: 'gpt-5.4',
            input: ['text'],
          },
        ],
      },
    });

    await expect(getPiAvailableModels()).resolves.toEqual([
      { value: 'openai/gpt-5.4', label: 'openai/gpt-5.4', supportsImages: false },
    ]);
  });

  it('filters malformed SDK model records', async () => {
    createAgentSessionServicesMock.mockResolvedValueOnce({
      modelRegistry: {
        getAvailable: () => [
          null,
          { provider: 'openai' },
          { id: 'gpt-5.4' },
          {
            provider: 'openai',
            id: 'gpt-5.4',
            input: ['text', 'image'],
          },
        ],
      },
    });

    await expect(getPiAvailableModels()).resolves.toEqual([
      { value: 'openai/gpt-5.4', label: 'openai/gpt-5.4', supportsImages: true },
    ]);
  });

  it('falls back to Pi Default when SDK model discovery fails', async () => {
    createAgentSessionServicesMock.mockRejectedValueOnce(new Error('model registry failed'));

    await expect(getPiModels()).resolves.toEqual(PI_MODELS.OPTIONS);
  });
});
