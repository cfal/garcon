import { describe, expect, it } from 'vitest';
import {
	CodexSubagentToolUseMessage,
	ToolResultMessage,
	type ChatMessage,
} from '$shared/chat-types';
import { buildSubagentManagementModel } from '../subagent-management';

const TS = '2024-01-01T00:00:00Z';

describe('buildSubagentManagementModel', () => {
	it('returns only the root entry when no subagents are present', () => {
		const model = buildSubagentManagementModel([], {
			rootTitle: 'Main chat',
			rootModel: 'gpt-5',
			rootStatus: 'idle',
		});

		expect(model.entries).toHaveLength(1);
		expect(model.subagents).toHaveLength(0);
		expect(model.entries[0]).toMatchObject({
			kind: 'root',
			name: 'Main chat',
			model: 'gpt-5',
			statusLabel: 'Idle',
		});
	});

	it('creates a subagent entry from a spawn tool event', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-1', 'spawn_agent', {
				taskName: 'review-auth',
				message: 'Review auth boundaries',
				model: 'gpt-5.5',
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.entries).toHaveLength(2);
		expect(model.subagents[0]).toMatchObject({
			kind: 'subagent',
			name: 'review-auth',
			model: 'gpt-5.5',
			message: 'Review auth boundaries',
			status: 'running',
			statusLabel: 'Running',
			lastActionLabel: 'Spawned',
			anchorId: 'tool-input-tool-subagent-1',
		});
	});

	it('merges follow-up events into the spawned subagent by target alias', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-1', 'spawn_agent', {
				taskName: 'review-auth',
				message: 'Review auth boundaries',
				model: 'gpt-5.5',
			}),
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-2', 'followup_task', {
				target: '/root/review-auth',
				message: 'Check websocket auth too',
			}),
		];

		const model = buildSubagentManagementModel(messages);

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			name: 'review-auth',
			path: '/root/review-auth',
			message: 'Check websocket auth too',
			lastActionLabel: 'Follow-up',
			anchorId: 'tool-input-tool-subagent-1',
		});
	});

	it('marks errored and lifecycle events with stable statuses', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-1', 'spawn_agent', {
				taskName: 'review-auth',
			}),
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-2', 'wait_agent', {
				target: '/root/review-auth',
			}),
			new ToolResultMessage(TS, 'tool-subagent-2', { content: 'timed out' }, true),
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-3', 'close_agent', {
				target: '/root/review-auth',
			}),
		];

		const errored = buildSubagentManagementModel(messages.slice(0, 3));
		expect(errored.subagents[0]).toMatchObject({
			status: 'error',
			statusLabel: 'Error',
		});

		const closed = buildSubagentManagementModel(messages);
		expect(closed.subagents[0]).toMatchObject({
			status: 'closed',
			statusLabel: 'Closed',
			lastActionLabel: 'Closed',
		});
	});
});
