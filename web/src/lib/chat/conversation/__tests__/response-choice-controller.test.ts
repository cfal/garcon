import { describe, expect, it, vi } from 'vitest';
import { ResponseChoiceController } from '../response-choice-controller.svelte.js';
import { CommandOutcomeUnknownError } from '../idempotent-command.js';

describe('ResponseChoiceController', () => {
	it('retains a synchronous sending fence across replacement view callbacks', async () => {
		const controller = new ResponseChoiceController();
		const delivery = Promise.withResolvers<boolean>();
		const send = vi.fn(() => delivery.promise);
		const pending = controller.submit('chat:view:3', 'chat', send);
		expect(controller.status('chat:view:3')).toBe('sending');
		expect(send).toHaveBeenCalledOnce();
		const replacementSend = vi.fn().mockResolvedValue(true);
		expect(await controller.submit('chat:view:3', 'chat', replacementSend)).toBe(false);
		expect(replacementSend).not.toHaveBeenCalled();
		delivery.resolve(true);
		expect(await pending).toBe(true);
		expect(controller.status('chat:view:3')).toBe('sent');
		expect(await controller.submit('chat:view:3', 'chat', replacementSend)).toBe(false);
		expect(replacementSend).not.toHaveBeenCalled();
	});

	it('retains an unknown fence after the original view is discarded', async () => {
		const controller = new ResponseChoiceController();
		const unknown = new CommandOutcomeUnknownError();
		await expect(
			controller.submit('chat:view:3', 'chat', () => Promise.reject(unknown)),
		).rejects.toBe(unknown);
		expect(controller.status('chat:view:3')).toBe('unknown');
		const replacementSend = vi.fn().mockResolvedValue(true);
		expect(await controller.submit('chat:view:3', 'chat', replacementSend)).toBe(false);
		expect(replacementSend).not.toHaveBeenCalled();
		expect(controller.status('chat:view:3')).toBe('unknown');
	});

	it('releases a definitely refused answer for a deliberate retry', async () => {
		const controller = new ResponseChoiceController();
		const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		expect(await controller.submit('chat:view:3', 'chat', send)).toBe(false);
		expect(controller.status('chat:view:3')).toBeUndefined();
		expect(await controller.submit('chat:view:3', 'chat', send)).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('releases a definitely failed answer and preserves its original error', async () => {
		const controller = new ResponseChoiceController();
		const failure = new Error('Definite refusal');
		const send = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(true);
		await expect(controller.submit('chat:view:3', 'chat', send)).rejects.toBe(failure);
		expect(controller.status('chat:view:3')).toBeUndefined();
		expect(await controller.submit('chat:view:3', 'chat', send)).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('releases a synchronously thrown send failure', async () => {
		const controller = new ResponseChoiceController();
		const failure = new Error('Not dispatched');
		await expect(
			controller.submit('chat:view:3', 'chat', () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(controller.status('chat:view:3')).toBeUndefined();
	});

	it('keeps independent keys answerable while another reply is pending', async () => {
		const controller = new ResponseChoiceController();
		const delivery = Promise.withResolvers<boolean>();
		const pending = controller.submit('chat:view:3', 'chat', () => delivery.promise);
		expect(await controller.submit('other:view:3', 'other', () => Promise.resolve(true))).toBe(
			true,
		);
		expect(await controller.submit('chat:view:4', 'chat', () => Promise.resolve(true))).toBe(true);
		expect(controller.status('chat:view:3')).toBe('sending');
		delivery.resolve(false);
		await pending;
	});

	it('bounds retained completed answers by evicting the least recently used entry', async () => {
		const controller = new ResponseChoiceController();
		for (let index = 0; index < 200; index++) {
			await controller.submit(`key-${index}`, 'chat', () => Promise.resolve(true));
		}
		const repeated = vi.fn().mockResolvedValue(true);
		expect(await controller.submit('key-0', 'chat', repeated)).toBe(false);
		expect(repeated).not.toHaveBeenCalled();
		await controller.submit('key-200', 'chat', () => Promise.resolve(true));
		expect(controller.status('key-0')).toBe('sent');
		expect(controller.status('key-1')).toBeUndefined();
		expect(controller.status('key-2')).toBe('sent');
		expect(controller.status('key-200')).toBe('sent');
	});

	it('never evicts sending or unknown fences to retain another answer', async () => {
		const controller = new ResponseChoiceController();
		const delivery = Promise.withResolvers<boolean>();
		const pending = controller.submit('pending', 'chat', () => delivery.promise);
		await controller
			.submit('unknown', 'chat', () => Promise.reject(new CommandOutcomeUnknownError()))
			.catch(() => undefined);
		for (let index = 0; index < 198; index++) {
			await controller.submit(`sent-${index}`, 'chat', () => Promise.resolve(true));
		}
		await controller.submit('latest', 'chat', () => Promise.resolve(true));
		expect(controller.status('pending')).toBe('sending');
		expect(controller.status('unknown')).toBe('unknown');
		expect(controller.status('sent-0')).toBeUndefined();
		expect(controller.status('latest')).toBe('sent');
		delivery.resolve(true);
		await pending;
	});

	it('refuses a new send when all capacity is occupied by safety fences', async () => {
		const controller = new ResponseChoiceController();
		const delivery = Promise.withResolvers<boolean>();
		const pending = controller.submit('pending', 'chat', () => delivery.promise);
		for (let index = 0; index < 199; index++) {
			await controller
				.submit(`unknown-${index}`, 'chat', () => Promise.reject(new CommandOutcomeUnknownError()))
				.catch(() => undefined);
		}
		const send = vi.fn().mockResolvedValue(true);
		await expect(controller.submit('overflow', 'chat', send)).rejects.toThrow(
			'Waiting for pending answers',
		);
		expect(send).not.toHaveBeenCalled();
		expect(controller.status('overflow')).toBeUndefined();
		expect(controller.status('pending')).toBe('sending');
		expect(controller.status('unknown-0')).toBe('unknown');
		delivery.resolve(false);
		await pending;
		expect(await controller.submit('overflow', 'chat', send)).toBe(true);
	});

	it('prunes deleted chats and never restores them from late delivery', async () => {
		const controller = new ResponseChoiceController();
		const delivery = Promise.withResolvers<boolean>();
		const pending = controller.submit('deleted:view:3', 'deleted', () => delivery.promise);
		await controller.submit('retained:view:3', 'retained', () => Promise.resolve(true));
		await controller
			.submit('deleted:view:4', 'deleted', () => Promise.reject(new CommandOutcomeUnknownError()))
			.catch(() => undefined);
		controller.prune(new Set(['retained']));
		expect(controller.status('deleted:view:3')).toBeUndefined();
		expect(controller.status('deleted:view:4')).toBeUndefined();
		expect(controller.status('retained:view:3')).toBe('sent');
		delivery.resolve(true);
		expect(await pending).toBe(true);
		expect(controller.status('deleted:view:3')).toBeUndefined();
	});

	it('does not overwrite a replacement fence when an old pruned send fails late', async () => {
		const controller = new ResponseChoiceController();
		const first = Promise.withResolvers<boolean>();
		const second = Promise.withResolvers<boolean>();
		const old = controller.submit('chat:view:3', 'chat', () => first.promise);
		controller.prune(new Set());
		const current = controller.submit('chat:view:3', 'chat', () => second.promise);
		const unknown = new CommandOutcomeUnknownError();
		first.reject(unknown);
		await expect(old).rejects.toBe(unknown);
		expect(controller.status('chat:view:3')).toBe('sending');
		second.resolve(true);
		await current;
		expect(controller.status('chat:view:3')).toBe('sent');
	});
});
