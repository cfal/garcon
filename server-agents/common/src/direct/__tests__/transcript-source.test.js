import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { createDirectSessionPaths } from '../session-paths.ts';
import { createDirectCompatibleTranscriptSource } from '../transcript-source.ts';

const createdDirs = [];

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-direct-transcript-'));
  createdDirs.push(dir);
  return dir;
}

function source(root) {
  const paths = createDirectSessionPaths(root, 'sessions');
  return createDirectCompatibleTranscriptSource({
    agentId: 'direct-openai-compatible',
    sessionLabel: 'Direct (Chat Completions)',
    findSessionFilePath: paths.findSessionFilePath,
  });
}

async function writeTranscript(root, endpointId, sessionId, entries) {
  const dir = path.join(root, 'sessions', endpointId);
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
    expect(messages.map(getNativeMessageSource)).toEqual([
      { lineNumber: 1 },
      { lineNumber: 2 },
    ]);
  });

  it('releases the integration-owned transcript file', async () => {
    const root = await tempDir();
    const transcriptPath = path.join(root, 'sessions', 'chat_endpoint', 'session-1.jsonl');
    await writeTranscript(root, 'chat_endpoint', 'session-1', [
      { role: 'user', content: 'hello' },
    ]);

    const transcript = source(root);
    await transcript.release({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
      modelEndpointId: 'chat_endpoint',
    }, 'deleted');

    await expect(fs.access(transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('attaches one-based physical JSONL lines to rendered messages', async () => {
    const root = await tempDir();
    const dir = path.join(root, 'sessions', 'chat_endpoint');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session-1.jsonl'), [
      JSON.stringify({ role: 'user', content: 'one' }),
      '',
      JSON.stringify({ role: 'assistant', content: 'two' }),
      '',
    ].join('\n'));

    const messages = await source(root).loadMessages({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
      modelEndpointId: 'chat_endpoint',
    });

    expect(messages.map(getNativeMessageSource)).toEqual([
      { lineNumber: 1 },
      { lineNumber: 3 },
    ]);
  });

  it('restores direct user delivery identity from native history', async () => {
    const root = await tempDir();
    await writeTranscript(root, 'chat_endpoint', 'session-1', [{
      role: 'user',
      content: 'identified input',
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    }]);

    const messages = await source(root).loadMessages({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
      modelEndpointId: 'chat_endpoint',
    });

    expect(messages[0].metadata).toEqual({
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    });
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

  it('resolves an artificial native path to the existing recorded endpoint file', async () => {
    const root = await tempDir();
    await writeTranscript(root, 'removed_endpoint', 'recovered-session', [
      { role: 'user', content: 'old row' },
    ]);

    const transcript = source(root);
    const resolved = await transcript.resolveNativePath({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: null,
      modelEndpointId: 'removed_endpoint',
      nativePath: '!direct-openai-compatible:recovered-session',
    });

    expect(resolved).toBe(path.join(root, 'sessions', 'removed_endpoint', 'recovered-session.jsonl'));
  });

  it('returns null when no Direct transcript file exists', async () => {
    const root = await tempDir();
    const transcript = source(root);

    await expect(transcript.resolveNativePath({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'missing-session',
      modelEndpointId: 'chat_endpoint',
      nativePath: '!direct-openai-compatible:missing-session',
    })).resolves.toBeNull();
  });

  it('scans later compatible endpoints when the recorded endpoint has no transcript', async () => {
    const root = await tempDir();
    await writeTranscript(root, 'fallback_endpoint', 'session-1', [
      { role: 'user', content: 'found on fallback' },
    ]);
    const transcript = source(root);
    const session = {
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
      apiProviderId: 'acme',
      modelEndpointId: 'missing_endpoint',
      nativePath: '!direct-openai-compatible:session-1',
    };

    await expect(transcript.resolveNativePath(session)).resolves.toBe(
      path.join(root, 'sessions', 'fallback_endpoint', 'session-1.jsonl'),
    );
    const messages = await transcript.loadMessages(session);
    expect(messages.map((message) => message.content)).toEqual(['found on fallback']);
  });

  it('does not scan outside the integration storage namespace', async () => {
    const root = await tempDir();
    const outsideDir = path.join(root, 'other-sessions', 'responses_endpoint');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'session-1.jsonl'), `${JSON.stringify(
      { role: 'user', content: 'wrong protocol family' },
    )}\n`);

    const transcript = source(root);
    const messages = await transcript.loadMessages({
      agentId: 'direct-openai-compatible',
      projectPath: '/tmp/project',
      agentSessionId: 'session-1',
    });

    expect(messages).toEqual([]);
  });
});
