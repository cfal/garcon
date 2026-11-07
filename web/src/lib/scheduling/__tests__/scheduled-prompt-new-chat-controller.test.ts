import { describe, expect, it, vi } from 'vitest';
import { ScheduledPromptNewChatController, type ScheduledPromptNewChatControllerDeps } from '../scheduled-prompt-new-chat-controller.svelte';
import { scheduledPromptStartup } from '../scheduled-prompt-new-chat';
import type { RenderScheduledPromptResponse } from '$shared/scheduled-prompt-render';
import { scheduledNewChat, sourceChat } from './scheduled-prompt-new-chat-fixture';

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
		expect(controller.isOpening).toBe(true);
		const chatId = resolve();
		await opening;
		expect(open).toHaveBeenCalledWith({ prefill: `Review ${chatId}`, prospectiveChatId: chatId,
			startup: scheduledPromptStartup(task, undefined, undefined) });
		expect(task).toEqual(original);
		expect(controller.isOpening).toBe(false);
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

	it.each(['resolved', 'rejected'] as const)('keeps a replacement request pending after the cancelled request %s', async outcome => {
		const { task, pending, render, controller, open, resolve } = fixture();
		const firstOpening = controller.open(task);
		controller.cancel();
		expect(controller.isOpening).toBe(false);
		const replacement = Promise.withResolvers<RenderScheduledPromptResponse>();
		render.mockReturnValueOnce(replacement.promise);
		const nextOpening = controller.open(task);
		expect(controller.isOpening).toBe(true);

		if (outcome === 'resolved') resolve();
		else pending.reject(new Error('Cancelled render failure'));
		await firstOpening;
		expect(controller.isOpening).toBe(true);
		expect(controller.error).toBeNull();
		expect(open).not.toHaveBeenCalled();
		await controller.open(task);
		expect(render).toHaveBeenCalledTimes(2);

		const chatId = render.mock.calls[1][0].chatId;
		replacement.resolve({ success: true, chatId, expandedText: `Review ${chatId}` });
		await nextOpening;
		expect(controller.isOpening).toBe(false);
		expect(open).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ prospectiveChatId: chatId }));
	});

	it.each(['missing', 'routing', 'path', 'settings', 'tags'] as const)('rejects an existing-chat source with changed %s during rendering', async change => {
		const { deps, controller, open, resolve } = fixture();
		let chat: ReturnType<typeof sourceChat> | undefined = sourceChat();
		const settings = { mode: 'saved' };
		chat.agentSettings = { ...chat.agentSettings, values: settings };
		const task = { ...scheduledNewChat(), target: {
			type: 'existing-chat' as const, chatId: chat.id, busyBehavior: 'queue' as const,
		} };
		deps.startupFor.mockImplementation(() => scheduledPromptStartup(task, chat, 'conversation'));
		const opening = controller.open(task);
		switch (change) {
			case 'missing': chat = undefined; break;
			case 'routing': chat.modelEndpointId = 'replacement-endpoint'; break;
			case 'path': chat.projectPath = '/worker/other-project'; break;
			case 'settings': settings.mode = 'changed'; break;
			case 'tags': chat.tags.push('changed'); break;
		}
		resolve();
		await opening;
		expect(open).not.toHaveBeenCalled();
		expect(controller.error).toContain('target settings changed');
		expect(controller.isOpening).toBe(false);
	});

	it('keeps preparation failures actionable and never opens a partial seed', async () => {
		const { task, pending, controller, open } = fixture();
		const opening = controller.open(task);
		pending.reject(new Error('Synthetic render failure'));
		await opening;
		expect(controller.error).toBe('Synthetic render failure');
		expect(controller.isOpening).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});

	it('does not prepare unavailable sources', async () => {
		const { task, deps, render, controller } = fixture();
		deps.startupFor.mockReturnValue(null);
		await controller.open(task);
		expect(render).not.toHaveBeenCalled();
	});
});
