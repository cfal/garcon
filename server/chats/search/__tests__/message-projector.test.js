import { describe, expect, it } from 'bun:test';
import {
  PermissionResolvedMessage,
  TodoWriteToolUseMessage,
  ToolResultMessage,
  UnknownToolUseMessage,
  UserMessage,
} from '../../../../common/chat-types.js';
import { projectLiveMessages } from '../message-projector.js';

const timestamp = '2026-01-01T00:00:00.000Z';

describe('transcript search live projection', () => {
  it('caps text before whitespace normalization without requesting a redundant reload', () => {
    const result = projectLiveMessages([
      new UserMessage(timestamp, `${'word '.repeat(20_000)}tail`),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].body.length).toBeLessThanOrEqual(64_000);
    expect(result.requiresAuthoritativeReload).toBe(false);
  });

  it('bounds recursive payloads, tool arrays, and tool-result output', () => {
    const recursive = {};
    recursive.self = recursive;
    recursive.content = 'x'.repeat(50_000);
    const todos = Array.from({ length: 10_000 }, (_, index) => ({
      status: 'pending',
      content: `todo-${index}`,
    }));
    const result = projectLiveMessages([
      new UnknownToolUseMessage(timestamp, 'u1', 'Huge', recursive),
      new TodoWriteToolUseMessage(timestamp, 'u2', todos),
      new ToolResultMessage(timestamp, 'u3', { output: 'z'.repeat(100_000) }, false),
    ]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].body.length).toBeLessThanOrEqual(16_000);
    expect(result.rows[1].body.length).toBeLessThanOrEqual(16_000);
    expect(result.rows[2].body.length).toBeLessThanOrEqual(2_512);
    expect(result.requiresAuthoritativeReload).toBe(false);
  });

  it('bounds traversal even when a huge container has no searchable text', () => {
    const input = Array(10_000).fill(null);
    Object.defineProperty(input, 600, {
      get() {
        throw new Error('projector traversed beyond its node budget');
      },
    });

    const result = projectLiveMessages([
      new UnknownToolUseMessage(timestamp, 'u1', 'Huge', input),
    ]);

    expect(result.rows.map((row) => row.body)).toEqual(['Huge']);
    expect(result.requiresAuthoritativeReload).toBe(false);
  });

  it('stops projecting when the remaining queue capacity is exhausted', () => {
    const result = projectLiveMessages([
      new UserMessage(timestamp, 'one'),
      new UserMessage(timestamp, 'two'),
    ], 1);
    expect(result.rows.map((row) => row.body)).toEqual(['one']);
    expect(result.requiresAuthoritativeReload).toBe(true);
  });

  it('bounds omitted live messages independently from projected row count', () => {
    const messages = Array(3_000).fill(new PermissionResolvedMessage(timestamp, 'request', true));
    Object.defineProperty(messages, 2_500, {
      get() {
        throw new Error('projector traversed beyond its event budget');
      },
    });

    const result = projectLiveMessages(messages);

    expect(result.rows).toEqual([]);
    expect(result.requiresAuthoritativeReload).toBe(true);
  });

  it('bounds aggregate live text before it can monopolize the main thread', () => {
    const messages = Array.from({ length: 10 }, () => new UserMessage(timestamp, 'x'.repeat(64_000)));

    const result = projectLiveMessages(messages);

    expect(result.rows).toHaveLength(2);
    expect(result.requiresAuthoritativeReload).toBe(true);
  });
});
