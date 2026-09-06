import { describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

import { createChatPreambleRoutes } from '../chat-preambles.ts';

const CHAT_ID = '1783725900000200';
const VIEW = '12345678-1234-4123-8123-123456789abc';
const ID_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';

function routes(selection = {}) {
  const targetMock = mock(async () => ({
    success: true,
    chatId: CHAT_ID,
    transcriptViewId: VIEW,
    canonicalProjectPath: '/repo',
    selection: { revision: 0, orderedPreambleIds: [] },
    projection: {
      catalogRevision: 0,
      eligiblePreambles: [],
      unavailable: [],
    },
    ...selection,
  }));
  const updateMock = mock(async () => ({
    status: 'updated',
    mutationRevision: 1,
    noticeOrdinal: 1,
    selection: { revision: 1, orderedPreambleIds: [ID_A] },
    projection: {
      catalogRevision: 1,
      eligiblePreambles: [{ id: ID_A, title: 'Repository conventions' }],
      unavailable: [],
    },
  }));
  const preamblesMock = mock(() => ({
    revision: 1,
    preambles: [{
      id: ID_A,
      enabled: true,
      title: 'Repository conventions',
      content: 'body',
      scope: { type: 'global' },
      createdAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:00:00.000Z',
    }],
  }));
  const projectPathsMock = mock(async (projectPath) => projectPath);
  const map = createChatPreambleRoutes({
    selection: { target: targetMock, update: updateMock },
    preambles: { snapshot: preamblesMock },
    projectPaths: { resolve: projectPathsMock },
  });
  return { map, targetMock, updateMock, preamblesMock, projectPathsMock };
}

const validBody = {
  chatId: CHAT_ID,
  transcriptViewId: VIEW,
  clientRequestId: 'req-1',
  clientMessageId: 'msg-1',
  expectedRevision: 0,
  orderedPreambleIds: [ID_A],
};

function putRequest(body, headers = {}) {
  return new Request('http://localhost/api/v1/chats/preambles', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    ...body,
  });
}

describe('chat preamble routes', () => {
  it('returns the body-free selection target', async () => {
    const { map, targetMock } = routes();
    const request = new Request(`http://localhost/api/v1/chats/preambles?chatId=${CHAT_ID}`);
    const response = await map['/api/v1/chats/preambles'].GET(
      request,
      new URL(request.url),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      chatId: CHAT_ID,
      canonicalProjectPath: '/repo',
    });
    expect(targetMock).toHaveBeenCalledWith(CHAT_ID, expect.any(AbortSignal));
  });

  it('saves through the typed update contract', async () => {
    const { map, updateMock } = routes();
    const response = await map['/api/v1/chats/preambles'].PUT(putRequest({
      body: JSON.stringify(validBody),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      commandType: 'chat-preambles-update',
      status: 'updated',
    });
    expect(updateMock).toHaveBeenCalledWith(validBody);
  });

  it('rejects an oversized declared body before reading it', async () => {
    const { map, updateMock } = routes();
    const response = await map['/api/v1/chats/preambles'].PUT(putRequest({
      body: JSON.stringify(validBody),
    }, { 'content-length': String(32 * 1024 + 1) }));
    expect(response.status).toBe(413);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects a chunked multibyte body that exceeds the UTF-8 byte limit', async () => {
    const { map, updateMock } = routes();
    // Each character is 4 UTF-8 bytes, so the code-unit count stays far below
    // the limit while the byte length exceeds it; a code-unit check would pass.
    const payload = JSON.stringify({
      ...validBody,
      orderedPreambleIds: [ID_A],
      clientRequestId: 'x'.repeat(8 * 1024),
      padding: '\u{1F680}'.repeat(8 * 1024),
    });
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(32 * 1024);
    const response = await map['/api/v1/chats/preambles'].PUT(new Request(
      'http://localhost/api/v1/chats/preambles',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: ReadableStream.from([new TextEncoder().encode(payload)]),
        duplex: 'half',
      },
    ));
    expect(response.status).toBe(413);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 as malformed JSON', async () => {
    const { map, updateMock } = routes();
    const response = await map['/api/v1/chats/preambles'].PUT(new Request(
      'http://localhost/api/v1/chats/preambles',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: ReadableStream.from([new Uint8Array([0xc3, 0x28])]),
        duplex: 'half',
      },
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: 'Malformed JSON' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('surfaces typed partial failures with committed state', async () => {
    const { map } = routes();
    let updateMock;
    const failing = mock(async () => {
      const error = new Error('The selection was saved, but its transcript notice could not be recorded.');
      error.code = 'PREAMBLE_SELECTION_NOTICE_FAILED';
      throw error;
    });
    updateMock = failing;
    const mapFailing = createChatPreambleRoutes({
      selection: {
        target: mock(async () => ({})),
        update: failing,
      },
      preambles: { snapshot: mock(() => ({ revision: 0, preambles: [] })) },
      projectPaths: { resolve: mock(async (p) => p) },
    });
    const response = await mapFailing['/api/v1/chats/preambles'].PUT(putRequest({
      body: JSON.stringify(validBody),
    }));
    expect(response.status).toBe(500);
    expect(updateMock).toHaveBeenCalled();
  });

  it('projects preview defaults and explicit drafts without bodies', async () => {
    const { map, preamblesMock, projectPathsMock } = routes();
    const response = await map['/api/v1/preambles/selection-preview'].POST(new Request(
      'http://localhost/api/v1/preambles/selection-preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: '/repo' }),
      },
    ));
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      canonicalProjectPath: '/repo',
      orderedPreambleIds: [ID_A],
    });
    expect(JSON.stringify(body)).not.toContain('body');
    expect(preamblesMock).toHaveBeenCalledTimes(1);
    expect(projectPathsMock).toHaveBeenCalledWith('/repo');
  });
});
