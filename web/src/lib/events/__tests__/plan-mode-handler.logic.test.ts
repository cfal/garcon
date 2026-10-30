import { describe, expect, it, vi } from 'vitest';
import { handlePlanModeActivity, type PlanModeContext } from '../handlers/plan-mode';
import {
	BashToolUseMessage,
	EnterPlanModeToolUseMessage,
	ExitPlanModeToolUseMessage,
	type ChatMessage,
} from '$shared/chat-types';
import { summarizeTranscriptActivity } from '$shared/chat-transcript-activity';
import type { PendingPermissionRequest } from '$lib/types/chat';

function makeContext(mode = 'plan'): {
	ctx: PlanModeContext;
	read: () => PendingPermissionRequest[];
} {
	let pending: PendingPermissionRequest[] = [];
	const ctx: PlanModeContext = {
		getPermissionMode: () => mode as ReturnType<PlanModeContext['getPermissionMode']>,
		setPermissionMode: vi.fn(),
		conversationUi: {
			beginPlanModeForChat: vi.fn(),
			updatePendingPermissionsForChat: (_chatId, updater) => {
				pending = typeof updater === 'function' ? updater(pending) : updater;
			},
		},
	};
	return { ctx, read: () => pending };
}

function apply(messages: ChatMessage[], ctx: PlanModeContext, chatId = 'chat-1') {
	handlePlanModeActivity(chatId, summarizeTranscriptActivity(messages), ctx);
}

describe('plan mode handler', () => {
	it('maps an ExitPlanMode request into a pending plan approval', () => {
		const { ctx, read } = makeContext();

		apply([new ExitPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-123', 'Do X', [])], ctx);

		const pending = read();
		expect(pending).toHaveLength(1);
		expect(pending[0].permissionOccurrenceId).toBe('plan-exit-tool-123');
		expect(pending[0].requestedTool).toBeInstanceOf(ExitPlanModeToolUseMessage);
		expect((pending[0].requestedTool as ExitPlanModeToolUseMessage).plan).toBe('Do X');
	});

	it('sets plan permission mode on plan-mode entry', () => {
		const { ctx } = makeContext('default');

		apply([new EnterPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-456')], ctx);

		expect(ctx.conversationUi.beginPlanModeForChat).toHaveBeenCalledWith('chat-1', 'default');
		expect(ctx.setPermissionMode).toHaveBeenCalledWith('chat-1', 'plan');
	});

	it('does not remember a previous mode when already in plan mode', () => {
		const { ctx } = makeContext('plan');

		apply([new EnterPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-dup')], ctx);

		expect(ctx.conversationUi.beginPlanModeForChat).not.toHaveBeenCalled();
		expect(ctx.setPermissionMode).toHaveBeenCalledWith('chat-1', 'plan');
	});

	it('deduplicates a plan approval delivered twice', () => {
		const { ctx, read } = makeContext();
		const exit = new ExitPlanModeToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-dedup', 'Do Z');

		apply([exit], ctx);
		apply([exit], ctx);

		expect(read()).toHaveLength(1);
	});

	it('ignores activity without plan-mode facts', () => {
		const { ctx, read } = makeContext();

		apply([new BashToolUseMessage('2026-02-24T00:00:00.000Z', 'tool-789', 'ls')], ctx);

		expect(ctx.setPermissionMode).not.toHaveBeenCalled();
		expect(read()).toHaveLength(0);
	});
});
