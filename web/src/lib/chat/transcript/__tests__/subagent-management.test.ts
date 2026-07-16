import { describe, expect, it } from 'vitest';
import {
	CodexSubagentToolUseMessage,
	ToolResultMessage,
	type ChatMessage,
} from '$shared/chat-types';
import { buildSubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';

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

	it('does not create a fake subagent entry for list operations', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-list', 'list_agents'),
		];

		const model = buildSubagentManagementModel(messages);

		expect(model.subagents).toHaveLength(0);
	});

	it('applies multi-target lifecycle events to each targeted subagent', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-1', 'spawn_agent', {
				taskName: 'review-auth',
			}),
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-2', 'spawn_agent', {
				taskName: 'ui-polish',
			}),
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-3', 'wait_agent', {
				targets: ['/root/review-auth', '/root/ui-polish'],
			}),
		];

		const model = buildSubagentManagementModel(messages);

		expect(model.subagents).toHaveLength(2);
		expect(model.subagents.map((entry) => [entry.name, entry.status])).toEqual([
			['review-auth', 'waiting'],
			['ui-polish', 'waiting'],
		]);
	});

	it('uses typed lifecycle states to detect completed and missing workers', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-wait', 'wait_agent', {
				targets: ['worker-complete', 'worker-missing'],
				agentStates: {
					'worker-complete': { status: 'completed', message: 'Done' },
					'worker-missing': { status: 'notFound' },
				},
			}),
		];

		const model = buildSubagentManagementModel(messages);

		expect(model.subagents.map((entry) => [entry.name, entry.status, entry.statusLabel])).toEqual([
			['worker-complete', 'completed', 'Completed'],
			['worker-missing', 'error', 'Not found'],
		]);
	});

	it('maps shutdown and errored lifecycle states without leaving workers running', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'tool-subagent-close', 'close_agent', {
				targets: ['worker-stopped', 'worker-failed'],
				agentStates: {
					'worker-stopped': { status: 'shutdown' },
					'worker-failed': { status: 'errored', message: 'Process exited' },
				},
			}),
		];

		const model = buildSubagentManagementModel(messages);

		expect(model.subagents.map((entry) => [entry.name, entry.status, entry.statusLabel])).toEqual([
			['worker-stopped', 'closed', 'Stopped'],
			['worker-failed', 'error', 'Error'],
		]);
	});

	it('folds spawn, path discovery, and terminal notification into one worker', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'spawn-1', 'spawn_agent', {
				target: 'worker-thread-1',
				agentStates: { 'worker-thread-1': { status: 'running' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-1', 'agent_status', {
				target: '/root/reviewer',
				threadId: 'worker-thread-1',
				agentStates: { '/root/reviewer': { status: 'running' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'completion-1', 'agent_status', {
				target: '/root/reviewer',
				agentStates: {
					'/root/reviewer': { status: 'completed', message: 'Review complete' },
				},
			}),
		];

		const model = buildSubagentManagementModel(messages);

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			id: 'worker-thread-1',
			name: 'reviewer',
			path: '/root/reviewer',
			status: 'completed',
			statusLabel: 'Completed',
			message: 'Review complete',
		});
	});
});
