#!/usr/bin/env bun
import { createInterface } from 'node:readline';

const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    emit({ type: 'control_response', response: {
      request_id: frame.request_id, subtype: 'success', response: { commands: [] },
    } });
    continue;
  }
  if (frame.type !== 'user') continue;
  const session_id = frame.session_id;
  emit({ type: 'command_lifecycle', command_uuid: frame.uuid, state: 'started' });
  emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  emit({ type: 'stream_event', session_id, parent_tool_use_id: null, event: {
    type: 'content_block_start', content_block: { type: 'tool_use', id: 'call-a', name: 'Agent' },
  } });
  emit({ type: 'assistant', session_id, uuid: 'root-call', message: { content: [
    { type: 'tool_use', id: 'call-a', name: 'Agent', input: { description: 'Synthetic child', prompt: 'Synthetic kickoff' } },
  ] } });
  emit({ type: 'result', subtype: 'success', user_message_uuid: 'stale-input', result: 'Synthetic stale answer' });
  emit({ type: 'system', subtype: 'task_started', session_id, task_id: 'child-a', task_type: 'local_agent', tool_use_id: 'call-a' });
  emit({ type: 'assistant', session_id, agent_id: 'child-a', uuid: 'child-invalid', message: { content: [null] } });
  emit({ type: 'assistant', session_id, uuid: 'root-answer', message: { content: [{ type: 'text', text: 'Synthetic parent answer' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'Synthetic parent answer', user_message_uuid: frame.uuid });
  emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
}
