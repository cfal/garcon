import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const getOllamaUrl = mock(() => 'http://localhost:11434');
const isOllamaAutoDetect = mock(() => true);

mock.module('../../config.js', () => ({
  getOllamaUrl,
  isOllamaAutoDetect,
}));

import { OllamaBridge } from '../ollama-bridge.js';

const FAKE_TAGS_RESPONSE = {
  models: [
    { name: 'qwen3.5:latest', details: { parameter_size: '30B' } },
    { name: 'gpt-oss:20b', details: { parameter_size: '20B' } },
    { name: 'llama3:8b', details: {} },
  ],
};

describe('OllamaBridge', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    getOllamaUrl.mockReset();
    getOllamaUrl.mockReturnValue('http://localhost:11434');
    isOllamaAutoDetect.mockReset();
    isOllamaAutoDetect.mockReturnValue(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('detect', () => {
    it('returns true and populates models when Ollama is reachable', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(FAKE_TAGS_RESPONSE), { status: 200 })),
      );

      const bridge = new OllamaBridge('http://localhost:11434');
      const result = await bridge.detect();

      expect(result).toBe(true);
      expect(bridge.available).toBe(true);
      expect(bridge.getModels()).toHaveLength(3);
      expect(bridge.isOllamaModel('qwen3.5:latest')).toBe(true);
      expect(bridge.isOllamaModel('gpt-oss:20b')).toBe(true);
      expect(bridge.isOllamaModel('opus')).toBe(false);
    });

    it('returns false when Ollama is unreachable', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const bridge = new OllamaBridge('http://localhost:11434');
      const result = await bridge.detect();

      expect(result).toBe(false);
      expect(bridge.available).toBe(false);
      expect(bridge.getModels()).toHaveLength(0);
    });

    it('returns false when auto-detect is disabled', async () => {
      isOllamaAutoDetect.mockReturnValue(false);
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(FAKE_TAGS_RESPONSE), { status: 200 })),
      );

      const bridge = new OllamaBridge('http://localhost:11434');
      const result = await bridge.detect();

      expect(result).toBe(false);
      expect(bridge.available).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns false on non-200 response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Not Found', { status: 404 })),
      );

      const bridge = new OllamaBridge('http://localhost:11434');
      const result = await bridge.detect();

      expect(result).toBe(false);
      expect(bridge.available).toBe(false);
    });
  });

  describe('isOllamaModel', () => {
    it('correctly identifies known Ollama models', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(FAKE_TAGS_RESPONSE), { status: 200 })),
      );

      const bridge = new OllamaBridge('http://localhost:11434');
      await bridge.detect();

      expect(bridge.isOllamaModel('qwen3.5:latest')).toBe(true);
      expect(bridge.isOllamaModel('gpt-oss:20b')).toBe(true);
      expect(bridge.isOllamaModel('llama3:8b')).toBe(true);
      expect(bridge.isOllamaModel('opus')).toBe(false);
      expect(bridge.isOllamaModel('gpt-5.4')).toBe(false);
    });
  });

  describe('getClaudeEnvOverrides', () => {
    it('returns the correct env vars for Claude', () => {
      const bridge = new OllamaBridge('http://myhost:11434');
      const env = bridge.getClaudeEnvOverrides();

      expect(env).toEqual({
        ANTHROPIC_BASE_URL: 'http://myhost:11434',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_API_KEY: '',
      });
    });
  });

  describe('getCodexSdkOptions', () => {
    it('returns the correct SDK options for Codex', () => {
      const bridge = new OllamaBridge('http://myhost:11434');
      const opts = bridge.getCodexSdkOptions();

      expect(opts).toEqual({
        baseUrl: 'http://myhost:11434/v1',
        apiKey: 'ollama',
      });
    });
  });

  describe('refreshModels', () => {
    it('updates models when Ollama is available', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(FAKE_TAGS_RESPONSE), { status: 200 })),
      );

      const bridge = new OllamaBridge('http://localhost:11434');
      await bridge.detect();
      expect(bridge.getModels()).toHaveLength(3);

      const updatedResponse = {
        models: [
          { name: 'newmodel:latest', details: { parameter_size: '7B' } },
        ],
      };
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(updatedResponse), { status: 200 })),
      );

      const models = await bridge.refreshModels();
      expect(models).toHaveLength(1);
      expect(bridge.isOllamaModel('newmodel:latest')).toBe(true);
      expect(bridge.isOllamaModel('qwen3.5:latest')).toBe(false);
    });

    it('returns empty array when not available', async () => {
      const bridge = new OllamaBridge('http://localhost:11434');
      const models = await bridge.refreshModels();
      expect(models).toEqual([]);
    });
  });

  describe('constructor url', () => {
    it('uses the provided URL', () => {
      const bridge = new OllamaBridge('http://custom:9999');
      expect(bridge.url).toBe('http://custom:9999');
    });

    it('falls back to config when no URL is provided', () => {
      getOllamaUrl.mockReturnValue('http://config-host:1234');
      const bridge = new OllamaBridge();
      expect(bridge.url).toBe('http://config-host:1234');
    });
  });
});
