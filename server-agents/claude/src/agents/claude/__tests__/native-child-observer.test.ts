import { expect, test } from 'bun:test';
import { runtimeOperation, type AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { NATIVE_CHILD_CAPTURE_LIMITS } from '@garcon/server-agent-common/execution/native-child-capture-budget';
import { ClaudeNativeChildObserver } from '../native-child-observer.js';
import type { ClaudeCLIMessage } from '../cli-protocol.js';

function fixture() {
  const events: AgentRuntimeEvent[] = [];
  const cancellation = new AbortController();
  const operation = runtimeOperation('run-a', event => { events.push(event); });
  const observer = new ClaudeNativeChildObserver({ configHomeDir: '/synthetic/config',
    rootNativePath: '/synthetic/config/projects/project-a/root-a.jsonl', rootSessionId: 'root-a',
  }, cancellation.signal, operation.publish);
  return { events, cancellation, operation, observer };
}

function partial(id = 'tool-a'): ClaudeCLIMessage {
  return { type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'Agent' } } };
}

function assistant(id = 'tool-a'): ClaudeCLIMessage {
  return { type: 'assistant', uuid: 'root-message', message: { content: [
    { type: 'tool_use', id, name: 'Agent', input: { description: 'Synthetic child', prompt: 'Synthetic kickoff' } },
  ] } };
}

function started(agent = 'child-a', tool = 'tool-a'): ClaudeCLIMessage {
  return { type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: agent, tool_use_id: tool };
}

function content(uuid = 'child-message', agentId = 'child-a'): ClaudeCLIMessage {
  return { type: 'assistant', agent_id: agentId, parent_tool_use_id: 'tool-a', uuid,
    message: { content: [{ type: 'text', text: 'Synthetic child response' }] } };
}

function spawn(f: ReturnType<typeof fixture>, agent = 'child-a', tool = 'tool-a') {
  for (const frame of [partial(tool), assistant(tool), started(agent, tool)]) {
    f.observer.observeRootFrameSafely(frame, f.operation);
  }
}

test('admits only confirmed streamed root calls and drains bounded early child content', () => {
  const f = fixture();
  f.observer.acceptContentSafely({ ...content('input'), type: 'user', message: { content: 'Actual kickoff' } });
  spawn(f);
  f.observer.acceptContentSafely(content());
  f.observer.acceptContentSafely(content());
  expect(f.events.map(event => event.type)).toEqual([
    'native-child-created', 'native-child-status', 'native-child-rows', 'native-child-rows',
  ]);
  expect(f.events[0]).toMatchObject({ child: { parentKey: null, label: 'Synthetic child', model: null } });
  expect(f.events[2]).toMatchObject({ rows: [{ message: { type: 'user-message', content: 'Actual kickoff' } }] });
});

test('skips unrendered block families without losing adjacent content or retiring capture', () => {
  const f = fixture();
  spawn(f);
  f.observer.acceptContentSafely({ ...content(), message: { content: [
    { type: 'server_tool_use', id: 'server-tool' },
    { type: 'web_search_tool_result', tool_use_id: 'server-tool', content: [] },
    { type: 'text', text: 'Synthetic visible text' },
  ] } });
  f.observer.acceptContentSafely(content('next-message'));
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(2);
  expect(f.events.some(event => event.type === 'native-child-gap' || event.type === 'native-child-detached')).toBe(false);
});

test('abandons unadmitted invocations only when the runtime accepts settlement or interruption', () => {
  for (const accepted of [false, true]) {
    const f = fixture();
    f.observer.observeRootFrameSafely(partial(), f.operation);
    f.observer.observeRootFrameSafely(assistant(), f.operation);
    f.observer.observeRootFrameSafely({ type: 'result' }, f.operation);
    if (accepted) f.observer.abandonInvocations();
    f.observer.observeRootFrameSafely(started(), null);
    expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(accepted ? 0 : 1);
  }
});

test('a stale run terminal does not settle a continued child', () => {
  const f = fixture();
  spawn(f);
  f.observer.observeRootFrameSafely({ ...started(), run_id: 'new-run' }, null);
  f.observer.observeRootFrameSafely({ type: 'system', subtype: 'task_notification', task_id: 'child-a',
    run_id: 'old-run', status: 'completed' }, null);
  expect(f.events.filter(event => event.type === 'native-child-status')).toHaveLength(1);
});

test('retains captured publication after the root terminal and observes known continuations', () => {
  const f = fixture();
  spawn(f);
  f.observer.observeRootFrameSafely({ type: 'result' }, null);
  f.observer.acceptContentSafely(content());
  f.observer.observeRootFrameSafely({ type: 'system', subtype: 'task_notification', task_id: 'child-a', status: 'completed' }, null);
  f.observer.observeRootFrameSafely(started('child-a', 'send-message-call'), null);
  f.observer.acceptContentSafely(content('continued'));
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-status').map(event => event.status)).toEqual(['running', 'completed', 'running']);
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(2);
});

test.each(['task-only', 'complete-only', 'unconfirmed', 'replayed', 'nested', 'unowned'])(
  'does not discover from %s evidence', mode => {
    const f = fixture();
    if (mode !== 'task-only' && mode !== 'complete-only') {
      f.observer.observeRootFrameSafely({ ...partial(), ...(mode === 'nested' ? { parent_tool_use_id: 'outer-call' } : {}) },
        mode === 'unowned' ? null : f.operation);
    }
    if (mode !== 'task-only' && mode !== 'unconfirmed') {
      f.observer.observeRootFrameSafely({ ...assistant(), ...(mode === 'replayed' ? { isReplay: true } : {}) }, f.operation);
    }
    f.observer.observeRootFrameSafely(started(), f.operation);
    expect(f.events.filter(event => event.type === 'native-child-created')).toEqual([]);
  },
);

test('rebinding drops historical adoption even when the old complete assistant has no replay marker', () => {
  const first = fixture();
  spawn(first);
  first.cancellation.abort();
  const next = fixture();
  next.observer.observeRootFrameSafely(assistant(), next.operation);
  next.observer.observeRootFrameSafely(started(), next.operation);
  next.observer.acceptContentSafely(content());
  expect(next.events).toEqual([]);
  expect(first.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
});

test.each([false, true])('uncaptured children do not retire an admitted sibling (known ineligible: %s)', declined => {
  const f = fixture();
  spawn(f);
  for (let index = 0; index < 10; index++) {
    const agentId = `uncaptured-${index}`;
    if (declined) f.observer.observeRootFrameSafely(started(agentId, 'unknown-call'), f.operation);
    for (let row = 0; row < NATIVE_CHILD_CAPTURE_LIMITS.earlyPerChild; row++) {
      f.observer.acceptContentSafely(content(`row-${row}`, agentId));
    }
  }
  f.observer.acceptContentSafely(content('admitted-answer'));
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(1);
  expect(f.events.some(event => event.type === 'native-child-detached')).toBe(false);
});

test('retirement suppresses malformed content without propagating to parent ingress', () => {
  const f = fixture();
  spawn(f);
  expect(() => f.observer.acceptContentSafely({ ...content(), message: { content: [null] } })).not.toThrow();
  f.observer.acceptContentSafely(content('late'));
  spawn(f);
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-gap')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-detached')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(0);
});

test('saturated declined-child tracking stops admission without detaching captured siblings', () => {
  const f = fixture();
  spawn(f);
  for (let index = 0; index <= NATIVE_CHILD_CAPTURE_LIMITS.children; index++) {
    f.observer.observeRootFrameSafely(started(`declined-${index}`, 'unknown-call'), f.operation);
  }
  f.observer.acceptContentSafely(content('admitted-answer'));
  spawn(f, 'new-child', 'new-call');
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(1);
  expect(f.events.some(event => event.type === 'native-child-detached')).toBe(false);
});

test('a throwing observation publisher never escapes ingress or gap reporting', () => {
  const f = fixture();
  const operation = runtimeOperation('throwing', () => { throw new Error('Synthetic publication failure'); });
  expect(() => {
    for (const frame of [partial(), assistant(), started()]) f.observer.observeRootFrameSafely(frame, operation);
    f.observer.acceptContentSafely(content());
    f.observer.close();
  }).not.toThrow();
});

test('binding cancellation releases capture and rejects every late create or content callback', () => {
  const f = fixture();
  spawn(f);
  f.cancellation.abort();
  const count = f.events.length;
  f.observer.acceptContentSafely(content());
  spawn(f, 'child-b', 'tool-b');
  f.observer.close();
  expect(f.events).toHaveLength(count);
});

test('per-child early overflow records a gap and prevents later admission', () => {
  const f = fixture();
  for (let index = 0; index <= NATIVE_CHILD_CAPTURE_LIMITS.earlyPerChild; index++) f.observer.acceptContentSafely(content(`item-${index}`));
  spawn(f);
  expect(f.events.map(event => event.type)).toEqual(['native-child-gap']);
});

test('source-wide early overflow suppresses the unknown child without detaching admitted children', () => {
  const f = fixture();
  spawn(f);
  const oversized = { ...content('early', 'unknown'), message: { content: 'x'.repeat(900_000) } };
  for (let index = 0; index < 5; index++) f.observer.acceptContentSafely({ ...oversized, agent_id: `unknown-${index}` });
  f.observer.acceptContentSafely(content('late'));
  expect(f.events.some(event => event.type === 'native-child-gap')).toBe(true);
  expect(f.events.some(event => event.type === 'native-child-detached')).toBe(false);
  expect(f.events.some(event => event.type === 'native-child-rows')).toBe(true);
});

test('identity overflow retires rather than evicts identities and accepting replayed rows', () => {
  const f = fixture();
  spawn(f);
  for (let index = 0; index <= NATIVE_CHILD_CAPTURE_LIMITS.identitiesPerChild; index++) {
    f.observer.acceptContentSafely(content(`item-${index}`));
  }
  f.observer.acceptContentSafely(content('item-0'));
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(NATIVE_CHILD_CAPTURE_LIMITS.identitiesPerChild);
  expect(f.events.filter(event => event.type === 'native-child-gap')).toHaveLength(1);
  expect(f.events.at(-1)?.type).toBe('native-child-detached');
});
