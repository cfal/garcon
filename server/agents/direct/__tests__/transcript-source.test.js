import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDirectCompatibleTranscriptSource } from '../transcript-source.ts';

const createdDirs = [];

function endpoint(overrides = {}) {
  return {
    id: 'chat_endpoint',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    apiKey: '',
    capabilities: { chatCompletions: true, responses: false },
    defaultModel: 'example-model',
    models: [{ value: 'example-model', label: 'Example Model' }],
    supportsImages: false,
    modelDiscovery: 'openai-models',
    ...overrides,
  };
}

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-direct-transcript-'));
  createdDirs.push(dir);
  return dir;
}

function apiProviders(endpoints) {
  return {
    list: () => [{
      id: 'acme',
      label: 'Acme',
      endpoints,
    }],
    getEndpoint: (endpointId) => {
      const found = endpoints.find((entry) => entry.id === endpointId);
      return found ? { apiProvider: { id: 'acme', label: 'Acme', endpoints }, endpoint: found } : null;
    },
  };
}

function source(root, endpoints = [endpoint()]) {
  return createDirectCompatibleTranscriptSource({
    agentId: 'direct-openai-compatible',
    protocol: 'openai-compatible',
    sessionLabel: 'Direct (Chat Completions)',
    apiProviders: apiProviders(endpoints),
    getSessionFilePath: (endpointId, sessionId) => path.join(root, endpointId, `${sessionId}.jsonl`),
  });
}

async function writeTranscript(root, endpointId, sessionId, entries) {
  const dir = path.join(root, endpointId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}

describe('Direct compatible transcript source', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loads persisted Direct Chat messages from the recorded endpoint session file', async () => {
    const root = await tempDir();
    await writeTranscript(root, 'chat_endpoint', 'session-1', [
      { role: 'user', content: 'hello', timestamp: '2026-07-07T10:00:00.000Z' },
      { role: 'assistant', content: 'hi there', timestamp: '2026-07-07T10:00:01.000Z' },
    ]);

    const transcript = source(root);
    const messages = await transcript.loadMessages({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
      modelEndpointId: 'chat_endpoint',
    });

    expect(messages.map((message) => [message.type, message.content])).toEqual([
      ['user-message', 'hello'],
      ['assistant-message', 'hi there'],
    ]);
  });

  it('builds previews from persisted Direct Chat messages', async () => {
    const root = await tempDir();
    await writeTranscript(root, 'chat_endpoint', 'session-1', [
      { role: 'user', content: 'first request', timestamp: '2026-07-07T10:00:00.000Z' },
      { role: 'assistant', content: 'latest answer', timestamp: '2026-07-07T10:00:02.000Z' },
    ]);

    const transcript = source(root);
    const preview = await transcript.getPreview({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
      modelEndpointId: 'chat_endpoint',
    });

    expect(preview).toMatchObject({
      firstMessage: 'first request',
      lastMessage: 'latest answer',
      lastActivity: '2026-07-07T10:00:02.000Z',
    });
  });

  it('recovers the session ID from an artificial native path for older registry rows', async () => {
    const root = await tempDir();
    await writeTranscript(root, 'chat_endpoint', 'recovered-session', [
      { role: 'user', content: 'old row', timestamp: '2026-07-07T10:00:00.000Z' },
    ]);

    const transcript = source(root);
    const messages = await transcript.loadMessages({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: null,
      nativePath: '!direct-openai-compatible:recovered-session',
    });

    expect(messages.map((message) => message.content)).toEqual(['old row']);
  });

  it('falls back only to compatible endpoints when endpoint metadata is missing', async () => {
    const root = await tempDir();
    const responsesEndpoint = endpoint({
      id: 'responses_endpoint',
      capabilities: { chatCompletions: false, responses: true },
    });
    await writeTranscript(root, 'responses_endpoint', 'session-1', [
      { role: 'user', content: 'wrong protocol family' },
    ]);

    const transcript = source(root, [responsesEndpoint]);
    const messages = await transcript.loadMessages({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
    });

    expect(messages).toEqual([]);
  });
});
