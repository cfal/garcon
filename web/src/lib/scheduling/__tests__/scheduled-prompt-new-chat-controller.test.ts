import { describe, expect, it, vi } from 'vitest';
import { ScheduledPromptNewChatController, type ScheduledPromptNewChatControllerDeps } from '../scheduled-prompt-new-chat-controller.svelte';
import { scheduledPromptStartup } from '../scheduled-prompt-new-chat';
import type { RenderScheduledPromptResponse } from '$shared/scheduled-prompt-render';
import { scheduledNewChat } from './scheduled-prompt-new-chat-fixture';

function fixture() {
	const task = scheduledNewChat();
	const pending = Promise.withResolvers<RenderScheduledPromptResponse>();
	const render = vi.fn<NonNullable<ScheduledPromptNewChatControllerDeps['render']>>(() => pending.promise);
	const open = vi.fn();
	const deps = {
		active: true as boolean, newChatRequestId: 0, open, render,
		startupFor: vi.fn(() => scheduledPromptStartup(task, undefined, undefined)),
	} satisfies ScheduledPromptNewChatControllerDeps;
	const controller = new ScheduledPromptNewChatController(deps);
	function resolve() {
		const chatId = render.mock.calls[0][0].chatId;
		pending.resolve({ success: true, chatId, expandedText: `Review ${chatId}` });
		return chatId;
	}
	return { task, pending, render, open, deps, controller, resolve };
}

describe('scheduled prompt new-chat preparation', () => {
	it('prepares a copy with the rendered ID without mutating the paused schedule', async () => {
		const { task, render, open, controller, resolve } = fixture();
		const original = structuredClone(task);
		const opening = controller.open(task);
		await controller.open(task);
		expect(render).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
		expect(controller.openingPromptId).toBe(task.id);
		const chatId = resolve();
		await opening;
		expect(open).toHaveBeenCalledWith({ prefill: `Review ${chatId}`, prospectiveChatId: chatId,
			startup: scheduledPromptStartup(task, undefined, undefined) });
		expect(task).toEqual(original);
		expect(controller.openingPromptId).toBeNull();
	});

	it.each(['closed', 'superseded', 'cancelled'] as const)('ignores late rendering after %s', async reason => {
		const { task, deps, render, controller, open, resolve } = fixture();
		const opening = controller.open(task);
		if (reason === 'closed') deps.active = false;
		if (reason === 'superseded') deps.newChatRequestId += 1;
		if (reason === 'cancelled') controller.cancel();
		resolve();
		await opening;
		expect(open).not.toHaveBeenCalled();
		expect(controller.error).toBeNull();
		if (reason === 'cancelled') expect(render.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it.each(['missing', 'changed'] as const)('rejects a %s target during preparation instead of publishing mixed configuration', async reason => {
		const { task, deps, controller, open, resolve } = fixture();
		const opening = controller.open(task);
		deps.startupFor.mockReturnValue(reason === 'missing' ? null : {
			...scheduledPromptStartup(task, undefined, undefined)!, model: 'changed-model',
		});
		resolve();
		await opening;
		expect(open).not.toHaveBeenCalled();
		expect(controller.error).toContain('target settings changed');
	});

	it('keeps preparation failures actionable and never opens a partial seed', async () => {
		const { task, pending, controller, open } = fixture();
		const opening = controller.open(task);
		pending.reject(new Error('Synthetic render failure'));
		await opening;
		expect(controller.error).toBe('Synthetic render failure');
		expect(controller.openingPromptId).toBeNull();
		expect(open).not.toHaveBeenCalled();
	});

	it('does not prepare unavailable sources', async () => {
		const { task, deps, render, controller } = fixture();
		deps.startupFor.mockReturnValue(null);
		await controller.open(task);
		expect(render).not.toHaveBeenCalled();
	});
});
