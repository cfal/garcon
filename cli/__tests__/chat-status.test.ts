import { describe, expect, test } from 'bun:test';
import type { ChatSnapshotResponse } from '@garcon/common/chat-snapshot';
import {
	AssistantMessage,
	ErrorMessage,
	ToolResultMessage,
	TranscriptNoticeMessage,
	UserMessage,
} from '@garcon/common/chat-types';
import type { StatusCliCommand } from '../args.js';
import { formatChatStatus, runChatStatus, type ChatStatusClient } from '../chat-status.js';
import { GarconHttpError } from '../garcon-client.js';
import type { CliOutput } from '../output.js';

const CHAT_ID = '1785337200123456';
const TIMESTAMP = '2026-08-04T12:00:00.000Z';
const command: StatusCliCommand = {
  kind: 'status',
  workspace: 'work',
  configDir: '/config',
  chatId: CHAT_ID,
  messageLimit: 10,
  json: false,
};

function snapshot(overrides: Partial<ChatSnapshotResponse> = {}): ChatSnapshotResponse {
  return {
    observedAt: TIMESTAMP,
    messageLimit: 10,
    chat: {
      id: CHAT_ID,
      title: 'Implement validation',
      agentId: 'codex',
      agentOwnershipEpoch: 'epoch-1',
      carryOverRevision: 'carry-v5:abc',
      model: 'gpt-5.4',
      apiProviderId: 'local-openai',
      modelEndpointId: 'east',
      modelProtocol: 'openai-compatible',
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      projectPath: '/work/project',
      tags: ['cli', 'review'],
      canReloadFromNativeHistory: true,
      activity: { createdAt: TIMESTAMP, lastActivityAt: TIMESTAMP },
    },
    processingPhase: 'running',
    control: {
      serverInstanceId: 'instance-1',
      queue: {
        entries: [],
        steeringEntryId: null,
        recentlyDispatched: [],
        pause: null,
        reorderRevision: 0,
      },
      version: 0,
      updatedAt: null,
    },
    transcript: {
      availability: 'available',
      transcriptViewId: 'view-1',
      messages: [{ ordinal: 1, message: new AssistantMessage(TIMESTAMP, 'Working') }],
      lastOrdinal: 1,
      pageOldestOrdinal: 1,
      pageNewestOrdinal: 1,
      hasMore: false,
    },
    transientFeed: {
      serverInstanceId: 'instance-1',
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      transientRevision: 0,
      rows: [],
    },
    ...overrides,
  };
}

function output(): CliOutput & { results: string[] } {
  return {
    results: [],
    accepted() {},
    completed() {},
    result(content) { this.results.push(content); },
    sent() {},
    stopped() {},
    diagnostic() {},
  };
}

describe('chat status', () => {
  test('formats provider-neutral running status and transcript metadata', () => {
    expect(formatChatStatus(snapshot())).toBe([
      `chat id: ${CHAT_ID}`,
      'status: running',
      `observed at: ${TIMESTAMP}`,
      'title: Implement validation',
      'agent: codex',
      'ownership epoch: epoch-1',
      'carryover revision: carry-v5:abc',
      'model: gpt-5.4',
      'provider: local-openai',
      'endpoint: east',
      'protocol: openai-compatible',
      'project path: /work/project',
      'tags: cli, review',
      'queue: 0',
      'transcript: view view-1, last ordinal 1, showing 1',
      '',
      `[1] ${TIMESTAMP} assistant-message`,
      'Working',
    ].join('\n'));
  });

  test('keeps idle, queue, pause, and transcript availability separate', () => {
    const value = formatChatStatus(snapshot({
      processingPhase: null,
      control: {
        ...snapshot().control,
        queue: {
          ...snapshot().control.queue,
          entries: [{
            id: 'queued-1',
            content: 'Later',
            revision: 1,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          }],
          steeringEntryId: 'steering-1',
          pause: { id: 'pause-1', kind: 'manual', pausedAt: TIMESTAMP },
        },
      },
      transcript: {
        availability: 'unavailable',
        errorCode: 'TRANSCRIPT_UNAVAILABLE',
        retryable: true,
        message: 'Retry the request',
      },
    }));

    expect(value).toContain('status: idle');
    expect(value).toContain('queue: 1');
    expect(value).toContain('queue steering: steering-1');
    expect(value).toContain('queue paused: manual');
    expect(value).toContain('transcript: unavailable (TRANSCRIPT_UNAVAILABLE, retryable: yes)');
  });

  test('reports the established stopping phase directly', () => {
    expect(formatChatStatus(snapshot({ processingPhase: 'stopping' })))
      .toContain('status: stopping');
  });

  test('omits transcript output when messages were not requested', () => {
    const value = formatChatStatus(snapshot({
      messageLimit: 0,
      transcript: { availability: 'not-requested' },
    }));

    expect(value).not.toContain('transcript:');
  });

  test('redacts images and data URLs while preserving unrelated data fields', () => {
    const value = formatChatStatus(snapshot({
      transcript: {
        availability: 'available',
        transcriptViewId: 'view-1',
        messages: [{
          ordinal: 1,
          message: new UserMessage(TIMESTAMP, 'Review', [{
            data: 'data:image/png;base64,secret',
            name: 'image.png',
            mimeType: 'image/png',
          }]),
        }, {
          ordinal: 2,
          message: new ToolResultMessage(TIMESTAMP, 'tool-1', {
            data: 'ordinary-data',
            preview: 'data:image/png;base64,secret',
          }, false),
        }],
        lastOrdinal: 2,
        pageOldestOrdinal: 1,
        pageNewestOrdinal: 2,
        hasMore: false,
      },
    }));

    expect(value).toContain('[1 image attachments omitted from text output]');
    expect(value).toContain('"data": "ordinary-data"');
    expect(value).toContain('[data URL omitted from text output]');
    expect(value).not.toContain('base64,secret');
  });

  test('truncates each large message with a JSON escape hatch', () => {
    const value = formatChatStatus(snapshot({
      transcript: {
        availability: 'available',
        transcriptViewId: 'view-1',
        messages: [{ ordinal: 1, message: new AssistantMessage(TIMESTAMP, 'x'.repeat(5_000)) }],
        lastOrdinal: 1,
        pageOldestOrdinal: 1,
        pageNewestOrdinal: 1,
        hasMore: true,
      },
    }));

    expect(value).toContain('older messages available');
    expect(value).toContain('... [truncated; use --json for the complete snapshot]');
    expect(value).not.toContain('x'.repeat(4_001));
  });

  test('marks CLI rows and titles without relabeling provider errors', () => {
    const value = formatChatStatus(snapshot({
      transcript: {
        availability: 'available',
        transcriptViewId: 'view-1',
        messages: [{
          ordinal: 1,
          message: new TranscriptNoticeMessage(
            TIMESTAMP,
            'Deployment window opened.',
            { type: 'cli-row', title: 'Deployment' },
          ),
        }, {
          ordinal: 2,
          message: new ErrorMessage(
            TIMESTAMP,
            'Validation failed.',
            { type: 'cli-row' },
          ),
        }, {
          ordinal: 3,
          message: new ErrorMessage(TIMESTAMP, 'Provider failed.'),
        }],
        lastOrdinal: 3,
        pageOldestOrdinal: 1,
        pageNewestOrdinal: 3,
        hasMore: false,
      },
    }));

    expect(value).toContain(
      `[1] ${TIMESTAMP} transcript-notice (CLI) — Deployment\nDeployment window opened.`,
    );
    expect(value).toContain(`[2] ${TIMESTAMP} error (CLI)\nValidation failed.`);
    expect(value).toContain(`[3] ${TIMESTAMP} error\nProvider failed.`);
    expect(value).not.toContain(`[3] ${TIMESTAMP} error (CLI)`);
  });

  test('shows a plain notice title without CLI provenance', () => {
    const value = formatChatStatus(snapshot({
      transcript: {
        availability: 'available',
        transcriptViewId: 'view-1',
        messages: [{
          ordinal: 1,
          message: new TranscriptNoticeMessage(
            TIMESTAMP,
            'Model provider retrying: quota exhausted.',
            undefined,
            'Provider retry',
          ),
        }],
        lastOrdinal: 1,
        pageOldestOrdinal: 1,
        pageNewestOrdinal: 1,
        hasMore: false,
      },
    }));

    expect(value).toContain(
      `[1] ${TIMESTAMP} transcript-notice — Provider retry\n`
        + 'Model provider retrying: quota exhausted.',
    );
    expect(value).not.toContain('(CLI)');
  });

  test('passes request correlation and emits the unchanged snapshot as JSON', async () => {
    const value = snapshot();
    const before = JSON.stringify(value);
    const signal = new AbortController().signal;
    const calls: unknown[][] = [];
    const client: ChatStatusClient = {
      async getChatSnapshot(...args) { calls.push(args); return value; },
    };
    const capture = output();

    await runChatStatus({ ...command, json: true }, client, capture, signal);

    expect(calls).toEqual([[CHAT_ID, 10, signal]]);
    expect(capture.results).toEqual([JSON.stringify(value, null, 2)]);
    expect(JSON.stringify(value)).toBe(before);
  });

  test('names the effective workspace when the chat is missing', async () => {
    const client: ChatStatusClient = {
      async getChatSnapshot() {
        throw new GarconHttpError(
          'chat status',
          'Session not found',
          404,
          'SESSION_NOT_FOUND',
          false,
        );
      },
    };

    await expect(runChatStatus(command, client, output()))
      .rejects.toThrow('Garcon workspace "work"');
  });
});
