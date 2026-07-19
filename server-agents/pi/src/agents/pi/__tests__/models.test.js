import { afterEach, describe, expect, it, mock } from 'bun:test';

const createAgentSessionServicesMock = mock(async () => ({
  modelRegistry: { getAvailable: () => [], getError: () => undefined },
}));
const authStorageCreateMock = mock(() => ({ drainErrors: () => [] }));
const getAgentDirMock = mock(() => '/tmp/pi-agent');

mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: authStorageCreateMock },
  createAgentSessionServices: createAgentSessionServicesMock,
  getAgentDir: getAgentDirMock,
}));

import {
  getPiAvailableModels,
  PiModelCatalogService,
} from '../pi-models.js';
import { testPiConfig } from './test-fixtures.js';

let models = new PiModelCatalogService(testPiConfig);

afterEach(() => {
  createAgentSessionServicesMock.mockReset();
  createAgentSessionServicesMock.mockImplementation(async () => ({
    modelRegistry: { getAvailable: () => [], getError: () => undefined },
  }));
  authStorageCreateMock.mockReset();
  authStorageCreateMock.mockImplementation(() => ({ drainErrors: () => [] }));
  getAgentDirMock.mockReset();
  getAgentDirMock.mockImplementation(() => '/tmp/pi-agent');
  models = new PiModelCatalogService(testPiConfig);
});

describe('Pi model discovery', () => {
  it('returns dynamically discovered SDK models with concise labels', async () => {
    createAgentSessionServicesMock.mockResolvedValueOnce({
      modelRegistry: {
        getError: () => undefined,
        getAvailable: () => [
          {
            provider: 'openai',
            id: 'gpt-5.4',
            input: ['text', 'image'],
          },
          {
            provider: 'fireworks',
            id: 'accounts/fireworks/models/deepseek-v3p1',
            input: ['text'],
          },
        ],
      },
    });

    await expect(models.getModels()).resolves.toEqual([
      { value: 'openai/gpt-5.4', label: 'openai: gpt-5.4', supportsImages: true },
      {
        value: 'fireworks/accounts/fireworks/models/deepseek-v3p1',
        label: 'fireworks: deepseek-v3p1',
        supportsImages: false,
      },
    ]);
  });

  it('returns SDK-discovered models without the static default option', async () => {
    createAgentSessionServicesMock.mockResolvedValueOnce({
      modelRegistry: {
        getError: () => undefined,
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
      { value: 'openai/gpt-5.4', label: 'openai: gpt-5.4', supportsImages: false },
    ]);
  });

  it('filters malformed SDK model records', async () => {
    createAgentSessionServicesMock.mockResolvedValueOnce({
      modelRegistry: {
        getError: () => undefined,
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
      { value: 'openai/gpt-5.4', label: 'openai: gpt-5.4', supportsImages: true },
    ]);
  });

  it('returns no models when SDK model discovery fails', async () => {
    createAgentSessionServicesMock.mockRejectedValueOnce(new Error('model registry failed'));

    await expect(models.getModels()).resolves.toEqual([]);
  });

  it('retries transient auth diagnostics before returning models', async () => {
    authStorageCreateMock
      .mockReturnValueOnce({ drainErrors: () => [new Error('auth.json is locked')] })
      .mockReturnValueOnce({ drainErrors: () => [] });
    createAgentSessionServicesMock
      .mockResolvedValueOnce({
        diagnostics: [],
        modelRegistry: {
          getError: () => undefined,
          getAvailable: () => [],
        },
      })
      .mockResolvedValueOnce({
        diagnostics: [],
        modelRegistry: {
          getError: () => undefined,
          getAvailable: () => [
            {
              provider: 'openai',
              id: 'gpt-5.4',
              input: ['text'],
            },
          ],
        },
      });

    await expect(models.getModelsStrict()).resolves.toEqual([
      { value: 'openai/gpt-5.4', label: 'openai: gpt-5.4', supportsImages: false },
    ]);
    expect(createAgentSessionServicesMock).toHaveBeenCalledTimes(2);
  });

  it('strict discovery rejects transient empty results when no cache exists', async () => {
    authStorageCreateMock.mockImplementation(() => ({ drainErrors: () => [new Error('auth.json is locked')] }));
    createAgentSessionServicesMock.mockImplementation(async () => ({
      diagnostics: [],
      modelRegistry: {
        getError: () => undefined,
        getAvailable: () => [],
      },
    }));

    await expect(models.getModelsStrict()).rejects.toThrow('auth.json is locked');
    await expect(models.getModels()).resolves.toEqual([]);
  });

  it('returns last-known-good models when a stale refresh fails transiently', async () => {
    const expected = [{ value: 'openai/gpt-5.4', label: 'openai: gpt-5.4', supportsImages: false }];
    authStorageCreateMock.mockReturnValueOnce({ drainErrors: () => [] });
    createAgentSessionServicesMock.mockResolvedValueOnce({
      diagnostics: [],
      modelRegistry: {
        getError: () => undefined,
        getAvailable: () => [
          {
            provider: 'openai',
            id: 'gpt-5.4',
            input: ['text'],
          },
        ],
      },
    });

    await expect(models.getModels()).resolves.toEqual(expected);
    models.expireForTests();

    authStorageCreateMock.mockImplementation(() => ({ drainErrors: () => [new Error('auth.json is locked')] }));
    createAgentSessionServicesMock.mockImplementation(async () => ({
      diagnostics: [],
      modelRegistry: {
        getError: () => undefined,
        getAvailable: () => [],
      },
    }));

    await expect(models.getModels()).resolves.toEqual(expected);
    await expect(models.getModelsStrict()).rejects.toMatchObject({ staleModels: expected });
  });
});
