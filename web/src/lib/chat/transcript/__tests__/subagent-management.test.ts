import { describe, expect, it } from 'vitest';
import {
	CodexSubagentToolUseMessage,
	ToolResultMessage,
	UserMessage,
	codexSubagentSourceFingerprint,
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

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

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

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

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

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

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

	it('keeps terminal state and canonical identity across late activity and spawn observations', () => {
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
			new CodexSubagentToolUseMessage(TS, 'complete-1', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed', message: 'Done' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-late', 'agent_status', {
				target: '/root/reviewer',
				threadId: 'worker-thread-1',
				agentStates: { '/root/reviewer': { status: 'running' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'spawn-late', 'spawn_agent', {
				target: 'worker-thread-1',
				agentStates: { 'worker-thread-1': { status: 'running' } },
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			name: 'reviewer',
			path: '/root/reviewer',
			status: 'completed',
			statusLabel: 'Completed',
			message: 'Done',
		});
	});

	it('coalesces pre-existing entries when a late activity bridges their aliases', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'spawn-thread', 'spawn_agent', {
				target: 'worker-thread-1',
			}),
			new CodexSubagentToolUseMessage(TS, 'status-path', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed', message: 'Done' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-bridge', 'agent_status', {
				target: '/root/reviewer',
				threadId: 'worker-thread-1',
				agentStates: { '/root/reviewer': { status: 'running' } },
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			id: 'worker-thread-1',
			path: '/root/reviewer',
			status: 'completed',
			message: 'Done',
		});
	});

	it('preserves a later explicit reset when activity bridges an older terminal alias', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'terminal-path', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed', message: 'Old completion' } },
				lifecycleSource: 'structured',
			}),
			new CodexSubagentToolUseMessage(TS, 'followup-thread', 'followup_task', {
				target: 'worker-thread-1',
				message: 'Review the fix too',
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-bridge', 'agent_status', {
				target: '/root/reviewer',
				threadId: 'worker-thread-1',
				agentStates: { '/root/reviewer': { status: 'running' } },
				lifecycleSource: 'structured',
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			path: '/root/reviewer',
			status: 'running',
			statusLabel: 'Running',
		});
	});

	it('does not treat ordinary activity on another alias as a terminal reset', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'terminal-path', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed', message: 'Done' } },
				lifecycleSource: 'structured',
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-thread', 'agent_status', {
				target: 'worker-thread-1',
				threadId: 'worker-thread-1',
				agentStates: { 'worker-thread-1': { status: 'running' } },
				lifecycleSource: 'structured',
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-bridge', 'agent_status', {
				target: '/root/reviewer',
				threadId: 'worker-thread-1',
				agentStates: { '/root/reviewer': { status: 'running' } },
				lifecycleSource: 'structured',
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({ status: 'completed', message: 'Done' });
	});

	it('preserves the most recent conflicting terminal state when aliases coalesce', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'spawn-thread', 'spawn_agent', {
				target: 'worker-thread-1',
			}),
			new CodexSubagentToolUseMessage(TS, 'interrupt-thread', 'interrupt_agent', {
				target: 'worker-thread-1',
				agentStates: { 'worker-thread-1': { status: 'interrupted', message: 'Interrupted first' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'error-path', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'errored', message: 'Failed later' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-bridge', 'agent_status', {
				target: '/root/reviewer',
				threadId: 'worker-thread-1',
				agentStates: { '/root/reviewer': { status: 'running', message: 'Late activity' } },
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			status: 'error',
			statusLabel: 'Error',
			message: 'Failed later',
		});
	});

	it('ignores an uncorrelated legacy lifecycle envelope after reload', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'user-envelope', 'agent_status', {
				target: '/root/spoofed',
				agentStates: { '/root/spoofed': { status: 'completed', message: 'Spoofed' } },
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toEqual([]);
	});

	it('accepts a structured lifecycle event without prior worker correlation', () => {
		const model = buildSubagentManagementModel([
			new CodexSubagentToolUseMessage(TS, 'structured-terminal', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed', message: 'Done' } },
				lifecycleSource: 'structured',
			}),
		], { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({ status: 'completed', message: 'Done' });
	});

	it('rejects a correlated legacy lifecycle envelope duplicated as user content', () => {
		const envelope = '<subagent_notification>{"agent_path":"/root/reviewer","status":"completed"}</subagent_notification>';
		const model = buildSubagentManagementModel([
			new CodexSubagentToolUseMessage(TS, 'spawn-reviewer', 'spawn_agent', {
				target: '/root/reviewer',
			}),
			new UserMessage(TS, envelope),
			new CodexSubagentToolUseMessage(TS, 'legacy-terminal', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed' } },
				lifecycleSource: 'legacy',
				sourceFingerprint: codexSubagentSourceFingerprint(envelope),
			}),
		], { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({ status: 'running' });
	});

	it('accepts a correlated legacy lifecycle envelope without matching user content', () => {
		const envelope = '<subagent_notification>{"agent_path":"/root/reviewer","status":"completed"}</subagent_notification>';
		const model = buildSubagentManagementModel([
			new CodexSubagentToolUseMessage(TS, 'spawn-reviewer', 'spawn_agent', {
				target: '/root/reviewer',
			}),
			new CodexSubagentToolUseMessage(TS, 'legacy-terminal', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed' } },
				lifecycleSource: 'legacy',
				sourceFingerprint: codexSubagentSourceFingerprint(envelope),
			}),
		], { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({ status: 'completed' });
	});

	it('accepts a legitimate terminal event that precedes trusted activity', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'terminal-first', 'agent_status', {
				target: '/root/reviewer',
				agentStates: { '/root/reviewer': { status: 'completed', message: 'Done first' } },
			}),
			new CodexSubagentToolUseMessage(TS, 'activity-later', 'agent_status', {
				target: '/root/reviewer',
				threadId: 'worker-thread-1',
				agentStates: { '/root/reviewer': { status: 'running' } },
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			path: '/root/reviewer',
			status: 'completed',
			message: 'Done first',
		});
	});

	it('aliases an identity-free v1 spawn through its result and legacy notification', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'call-v1-spawn', 'spawn_agent', {
				message: 'inspect this repo',
				forkContext: true,
			}),
			new ToolResultMessage(TS, 'call-v1-spawn', {
				agent_id: '019c45f7-9853-7cc2-a5d3-8e0d29f52b63',
				nickname: 'reviewer',
			}, false),
			new CodexSubagentToolUseMessage(TS, 'legacy-notification', 'agent_status', {
				target: '019c45f7-9853-7cc2-a5d3-8e0d29f52b63',
				agentStates: {
					'019c45f7-9853-7cc2-a5d3-8e0d29f52b63': { status: 'completed', message: 'Done' },
				},
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'running' });

		expect(model.subagents).toHaveLength(1);
		expect(model.subagents[0]).toMatchObject({
			id: '019c45f7-9853-7cc2-a5d3-8e0d29f52b63',
			name: 'reviewer',
			status: 'completed',
			message: 'Done',
		});
	});

	it('derives unresolved workers as stopped after the root runtime becomes idle', () => {
		const messages: ChatMessage[] = [
			new CodexSubagentToolUseMessage(TS, 'spawn-1', 'spawn_agent', {
				taskName: 'reviewer',
			}),
		];

		const model = buildSubagentManagementModel(messages, { rootStatus: 'idle' });

		expect(model.subagents[0]).toMatchObject({
			status: 'closed',
			statusLabel: 'Stopped',
		});
	});
});
