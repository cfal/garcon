import { describe, expect, test } from 'bun:test';
import * as messages from '@garcon/common/chat-types';
import { encodeWireProducerEvent, decodeWireProducerEvent, parseWireProducerEvent } from '../../node-wire.js';
import type { NodePermissionHandleRegistrar } from '../../contracts/node-wire.js';
import { snapshotNormalizedMessage } from '../../normalized-message-snapshot.js';

const at = '2026-09-09T00:00:00.000Z';
const occurrence = '00000000-0000-4000-8000-000000000001';
const toolId = 'tool-a';
const tool = new messages.BashToolUseMessage(at, toolId, 'pwd', 'Synthetic description');
const question = { id: 'question-a', prompt: 'Synthetic question', options: [{ id: 'option-a', label: 'Option' }] };
const noPermissions = {
  createHandle() { throw new Error('Unexpected permission handle'); },
  register() { throw new Error('Unexpected permission registration'); },
} satisfies NodePermissionHandleRegistrar;

const samples = {
  'user-message': new messages.UserMessage(at, 'Synthetic input', [], {}, { origin: 'cli', disclosure: 'collapsed' }),
  'assistant-message': new messages.AssistantMessage(at, 'Synthetic output'),
  thinking: new messages.ThinkingMessage(at, 'Synthetic reasoning'),
  'bash-tool-use': tool,
  'exec-tool-use': new messages.ExecToolUseMessage(at, toolId, '1 + 1', 'javascript'),
  'wait-tool-use': new messages.WaitToolUseMessage(at, toolId, 'execution-a', 10, 100, false),
  'read-tool-use': new messages.ReadToolUseMessage(at, toolId, '/synthetic/file', 1, 10, 11),
  'list-tool-use': new messages.ListToolUseMessage(at, toolId, '/synthetic'),
  'edit-tool-use': new messages.EditToolUseMessage(at, toolId, '/synthetic/file', 'old', 'new', [{ path: 'file', kind: 'edit' }]),
  'write-tool-use': new messages.WriteToolUseMessage(at, toolId, '/synthetic/file', 'Synthetic content'),
  'apply-patch-tool-use': new messages.ApplyPatchToolUseMessage(at, toolId, '/synthetic/file', 'old', 'new', 'Synthetic patch'),
  'grep-tool-use': new messages.GrepToolUseMessage(at, toolId, 'pattern', '/synthetic'),
  'glob-tool-use': new messages.GlobToolUseMessage(at, toolId, '*.ts', '/synthetic'),
  'web-search-tool-use': new messages.WebSearchToolUseMessage(at, toolId, 'Synthetic query'),
  'web-fetch-tool-use': new messages.WebFetchToolUseMessage(at, toolId, 'https://example.test', 'Synthetic prompt'),
  'todo-write-tool-use': new messages.TodoWriteToolUseMessage(at, toolId, []),
  'todo-read-tool-use': new messages.TodoReadToolUseMessage(at, toolId),
  'task-tool-use': new messages.TaskToolUseMessage(at, toolId, 'synthetic', 'Description', 'Prompt', 'model-a', 'task-a'),
  'codex-subagent-tool-use': new messages.CodexSubagentToolUseMessage(at, toolId, 'spawn_agent', { taskName: 'task-a' }),
  'update-plan-tool-use': new messages.UpdatePlanToolUseMessage(at, toolId, []),
  'write-stdin-tool-use': new messages.WriteStdinToolUseMessage(at, toolId, { chars: 'Synthetic input' }),
  'enter-plan-mode-tool-use': new messages.EnterPlanModeToolUseMessage(at, toolId),
  'exit-plan-mode-tool-use': new messages.ExitPlanModeToolUseMessage(at, toolId, 'Synthetic plan', [{ tool: 'bash', prompt: 'pwd' }]),
  'ask-user-question-tool-use': new messages.AskUserQuestionToolUseMessage(at, toolId, 'Synthetic title', [question]),
  'cursor-ask-question-tool-use': new messages.CursorAskQuestionToolUseMessage(at, toolId, 'Synthetic title', [question]),
  'cursor-create-plan-tool-use': new messages.CursorCreatePlanToolUseMessage(at, toolId, 'Plan', 'Name', 'Overview', [], false, []),
  'amp-finder-tool-use': new messages.AmpFinderToolUseMessage(at, toolId, 'Query'),
  'amp-oracle-tool-use': new messages.AmpOracleToolUseMessage(at, toolId, 'Task', 'Context', []),
  'amp-librarian-tool-use': new messages.AmpLibrarianToolUseMessage(at, toolId, 'Query', 'Context'),
  'amp-skill-tool-use': new messages.AmpSkillToolUseMessage(at, toolId, 'synthetic'),
  'amp-mermaid-tool-use': new messages.AmpMermaidToolUseMessage(at, toolId),
  'amp-handoff-tool-use': new messages.AmpHandoffToolUseMessage(at, toolId, 'Goal'),
  'amp-look-at-tool-use': new messages.AmpLookAtToolUseMessage(at, toolId, '/synthetic/file', 'Objective'),
  'amp-find-thread-tool-use': new messages.AmpFindThreadToolUseMessage(at, toolId, 'Query'),
  'amp-read-thread-tool-use': new messages.AmpReadThreadToolUseMessage(at, toolId, 'thread-a', 'Goal'),
  'amp-task-list-tool-use': new messages.AmpTaskListToolUseMessage(at, toolId, 'list', 'task-a', 'Title', 'pending'),
  'external-tool-use': new messages.ExternalToolUseMessage(at, toolId, 'synthetic-tool', {}, null),
  'mcp-tool-use': new messages.McpToolUseMessage(at, toolId, 'synthetic-server', 'synthetic-tool', {}),
  'request-permissions-tool-use': new messages.RequestPermissionsToolUseMessage(at, toolId, {}, 'Synthetic reason'),
  'unknown-tool-use': new messages.UnknownToolUseMessage(at, toolId, 'synthetic-unknown', {}),
  'tool-result': new messages.ToolResultMessage(at, toolId, { output: 'Synthetic result' }, false),
  error: new messages.ErrorMessage(at, 'Synthetic error'),
  'transcript-notice': new messages.TranscriptNoticeMessage(at, 'Synthetic notice', { type: 'handoff-summary' }, 'Title'),
  'cli-row': new messages.CliRowMessage(at, 'Synthetic row', { style: 'notice' }, 'plain', 'Title'),
  'permission-request': new messages.PermissionRequestMessage(at, occurrence, tool),
  'permission-resolved': new messages.PermissionResolvedMessage(at, occurrence, true),
  'permission-cancelled': new messages.PermissionCancelledMessage(at, occurrence, 'cancelled'),
  'permission-expired': new messages.PermissionExpiredMessage(at, occurrence),
  compaction: new messages.CompactionMessage(at, 'auto', 'Synthetic summary', 100, 50),
  'agent-switch': new messages.AgentSwitchMessage(at, 'provider-a', 'provider-b', 'model-a', 'model-b'),
} satisfies Record<messages.ChatMessage['type'], messages.ChatMessage>;

describe('in-process normalized message snapshots', () => {
  test.each(Object.values(samples))('reconstructs a private typed $type snapshot without wire framing', (message) => {
    const snapshot = snapshotNormalizedMessage(message);
    const canonical = messages.parseChatMessage({ ...structuredClone(message) });
    if (!canonical) throw new Error('Invalid synthetic message');
    expect(snapshot).not.toBe(message);
    expect(snapshot).toBeInstanceOf(message.constructor);
    expect(snapshot).toEqual(canonical);
  });

  test('retains nested tool classes and private data ownership', () => {
    const requestedTool = new messages.McpToolUseMessage(at, toolId, 'synthetic-server', 'synthetic-tool', { items: ['original'] });
    const request = new messages.PermissionRequestMessage(at, occurrence, requestedTool);
    const snapshot = snapshotNormalizedMessage(request);
    if (snapshot.type !== 'permission-request') throw new Error('Unexpected snapshot type');
    expect(snapshot.requestedTool).toBeInstanceOf(messages.McpToolUseMessage);
    expect(snapshot.requestedTool).not.toBe(requestedTool);
    expect(snapshot).toEqual(request);
    requestedTool.input.items = ['changed'];
    expect(snapshot.requestedTool).toMatchObject({ input: { items: ['original'] } });
  });

  test('rejects malformed normalized message fields', () => {
    expect(() => snapshotNormalizedMessage({ ...tool, command: 42 } as unknown as messages.ChatMessage))
      .toThrow('Invalid normalized transcript message');
  });
});

describe('node wire message shapes', () => {
  test.each(Object.values(samples))('normalizes and round-trips typed $type messages', (message) => {
    const canonical = messages.parseChatMessage(JSON.parse(JSON.stringify(message)));
    if (!canonical) throw new Error('Invalid synthetic message');
    const wire = encodeWireProducerEvent({ type: 'rows', rows: [{ message }] }, noPermissions);
    expect(parseWireProducerEvent(wire)).toEqual(wire);
    expect(decodeWireProducerEvent(wire, () => { throw new Error('Unexpected permission resolution'); }))
      .toEqual({ type: 'rows', rows: [{ message: canonical }] });
  });

  test.each(Object.values(samples))('rejects wrong runtime field types for $type', (message) => {
    const raw = JSON.parse(JSON.stringify(message));
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'type') continue;
      const invalid = { ...raw, [key]: value === null || typeof value === 'string' ? 42 : 'invalid-shape' };
      expect(parseWireProducerEvent({ type: 'rows', rows: [{ message: invalid, providerMeta: null }] }), key).toBeNull();
    }
  });

  test('rejects invalid nested tool shapes before allocating permission handles', () => {
    let handles = 0;
    for (const requestedTool of [
      { ...tool, command: 42 },
      { ...samples['codex-subagent-tool-use'], details: { agentStates: { 'agent-a': { status: 'invalid' } } } },
      { ...samples['ask-user-question-tool-use'], questions: [{ ...question, options: [{ id: 'a', label: false }] }] },
      { ...samples['cursor-create-plan-tool-use'], phases: [{ name: 'Phase', todos: [{ content: 'Todo', status: 'invalid' }] }] },
      { ...samples['todo-write-tool-use'], todos: [{ content: 'Todo', status: 'done' }] },
    ]) {
      expect(parseWireProducerEvent({ type: 'rows', rows: [{ message: {
        ...samples['permission-request'], requestedTool,
      }, providerMeta: null }] })).toBeNull();
      const malformed = { type: 'permission', runId: 'run-a', lifecycle: {
        kind: 'requested', permissionOccurrenceId: occurrence, requestedTool, options: [],
      }, decision: { permissionOccurrenceId: occurrence, async respond() {} } };
      expect(() => encodeWireProducerEvent(malformed as Parameters<typeof encodeWireProducerEvent>[0], {
        createHandle() { handles += 1; return 'decision-a'; },
        register: noPermissions.register,
      })).toThrow();
    }
    expect(handles).toBe(0);
  });

  test('requires the same occurrence UUID format in every permission message', () => {
    for (const type of ['permission-request', 'permission-resolved', 'permission-cancelled', 'permission-expired'] as const) {
      const valid = JSON.parse(JSON.stringify(samples[type]));
      expect(parseWireProducerEvent({ type: 'rows', rows: [{ message: valid, providerMeta: null }] })).not.toBeNull();
      for (const permissionOccurrenceId of ['not-a-uuid', '', '00000000-0000-1000-8000-000000000001', '00000000-0000-4000-8000-00000000000A']) {
        const message = { ...valid, permissionOccurrenceId };
        expect(parseWireProducerEvent({ type: 'rows', rows: [{ message, providerMeta: null }] })).toBeNull();
        expect(() => encodeWireProducerEvent({ type: 'rows', rows: [{ message }] }, noPermissions)).toThrow();
      }
    }
  });
});
