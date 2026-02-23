import { describe, expect, it, vi } from 'vitest';
import { handlePlanModeMessages, type PlanModeContext } from '../handlers/plan-mode';
import { AgentRunOutputMessage } from '$shared/ws-events';
import { BashToolUseMessage, EnterPlanModeToolUseMessage, ExitPlanModeToolUseMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';

function makeContext(mode = 'plan'): { ctx: PlanModeContext; read: () => PendingPermissionRequest[] } {
	let pending: PendingPermissionRequest[] = [];
	const ctx: PlanModeContext = {
		currentChatId: 'chat-1',
		permissionMode: mode as PlanModeContext['permissionMode'],
		setPermissionMode: vi.fn(),
		setPreviousPermissionMode: vi.fn(),
		setPendingPermissionRequests: (updater) => {
			pending = updater(pending);
		},
	};
	return { ctx, read: () => pending };
}

describe('plan mode handler', () => {
	it('maps ExitPlanMode tool-use into pending permission request', () => {
		const { ctx, read } = makeContext();
		const message = new AgentRunOutputMessage('chat-1', [
			new ExitPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-123', 'ExitPlanMode', 'Do X', []),
		]);

		handlePlanModeMessages(message, ctx);
		const pending = read();
		expect(pending).toHaveLength(1);
		expect(pending[0].toolName).toBe('ExitPlanMode');
		expect(pending[0].toolInput).toEqual({ plan: 'Do X', allowedPrompts: [] });
	});

	it('sets plan permission mode on EnterPlanMode tool-use', () => {
		const { ctx } = makeContext('default');
		const message = new AgentRunOutputMessage('chat-1', [
			new EnterPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-456', 'EnterPlanMode'),
		]);

		handlePlanModeMessages(message, ctx);
		expect(ctx.setPreviousPermissionMode).toHaveBeenCalledWith('default');
		expect(ctx.setPermissionMode).toHaveBeenCalledWith('plan');
	});

	it('handles enter_plan_mode (snake_case variant)', () => {
		const { ctx } = makeContext('default');
		const message = new AgentRunOutputMessage('chat-1', [
			new EnterPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-sc', 'enter_plan_mode'),
		]);

		handlePlanModeMessages(message, ctx);
		expect(ctx.setPreviousPermissionMode).toHaveBeenCalledWith('default');
		expect(ctx.setPermissionMode).toHaveBeenCalledWith('plan');
	});

	it('handles exit_plan_mode (snake_case variant)', () => {
		const { ctx, read } = makeContext();
		const message = new AgentRunOutputMessage('chat-1', [
			new ExitPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-sc-exit', 'exit_plan_mode', 'Do Y'),
		]);

		handlePlanModeMessages(message, ctx);
		const pending = read();
		expect(pending).toHaveLength(1);
		expect(pending[0].permissionRequestId).toBe('plan-exit-tool-sc-exit');
		expect(pending[0].toolName).toBe('ExitPlanMode');
	});

	it('does not call setPreviousPermissionMode when already in plan mode', () => {
		const { ctx } = makeContext('plan');
		const message = new AgentRunOutputMessage('chat-1', [
			new EnterPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-dup', 'EnterPlanMode'),
		]);

		handlePlanModeMessages(message, ctx);
		expect(ctx.setPreviousPermissionMode).not.toHaveBeenCalled();
		expect(ctx.setPermissionMode).toHaveBeenCalledWith('plan');
	});

	it('deduplicates ExitPlanMode with the same toolId', () => {
		const { ctx, read } = makeContext();
		const message = new AgentRunOutputMessage('chat-1', [
			new ExitPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-dedup', 'ExitPlanMode', 'Do Z'),
		]);

		handlePlanModeMessages(message, ctx);
		handlePlanModeMessages(message, ctx);
		expect(read()).toHaveLength(1);
	});

	it('is a no-op when messages array is missing', () => {
		const { ctx, read } = makeContext();
		const message = {
			type: 'agent-run-output',
			chatId: 'chat-1',
		} as AgentRunOutputMessage;

		handlePlanModeMessages(message, ctx);
		expect(ctx.setPermissionMode).not.toHaveBeenCalled();
		expect(read()).toHaveLength(0);
	});

	it('ignores non-plan-mode tool-use messages', () => {
		const { ctx, read } = makeContext();
		const message = new AgentRunOutputMessage('chat-1', [
			new BashToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-789', 'Bash', 'ls'),
		]);

		handlePlanModeMessages(message, ctx);
		expect(ctx.setPermissionMode).not.toHaveBeenCalled();
		expect(read()).toHaveLength(0);
	});
});
