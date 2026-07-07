import { describe, expect, it } from 'bun:test';
import { buildBrowserPushPayload } from '../browser-push-payload.js';

function attention(overrides = {}) {
  return {
    id: 'attention-1',
    chatId: 'chat-1',
    reason: 'completed',
    title: 'Build finished',
    body: 'Done',
    status: null,
    userMessage: 'run the build',
    assistantMessage: 'Build passed with no errors.',
    createdAt: '2026-07-07T00:00:00.000Z',
    meta: {
      title: 'Build finished',
      hasGeneratedTitle: true,
      agentId: 'codex',
      projectPath: '/workspace',
    },
    ...overrides,
  };
}

describe('browser push payload', () => {
  it('builds declarative Web Push payloads with same-origin navigation', () => {
    const payload = buildBrowserPushPayload({
      event: attention(),
      origin: 'https://garcon.example.test',
      previewMode: 'status-only',
      badgeCount: 3,
    });

    expect(payload.web_push).toBe(8030);
    expect(payload.notification.title).toBe('Build finished');
    expect(payload.notification.body).toBe('Chat completed');
    expect(payload.notification.navigate).toBe('https://garcon.example.test/chat/chat-1');
    expect(payload.notification.app_badge).toBe('3');
    expect(payload.notification.data.chatId).toBe('chat-1');
  });

  it('uses message previews only when explicitly configured', () => {
    const payload = buildBrowserPushPayload({
      event: attention(),
      origin: 'https://garcon.example.test',
      previewMode: 'message-preview',
      badgeCount: null,
    });

    expect(payload.notification.body).toBe('Build passed with no errors.');
    expect(payload.notification.app_badge).toBeUndefined();
  });

  it('prioritizes status text over message previews', () => {
    const payload = buildBrowserPushPayload({
      event: attention({ reason: 'failed', status: 'Failed: exit code 1' }),
      origin: 'https://garcon.example.test',
      previewMode: 'message-preview',
      badgeCount: null,
    });

    expect(payload.notification.body).toBe('Failed: exit code 1');
  });
});
