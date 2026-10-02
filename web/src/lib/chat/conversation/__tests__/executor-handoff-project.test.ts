import { describe, expect, it, vi } from 'vitest';
import { validateStart } from '$lib/api/chats';
import { ExecutorHandoffProjectState } from '../executor-handoff-project.svelte.ts';

vi.mock('$lib/api/chats', () => ({ validateStart: vi.fn() }));
const executorId = '22222222-2222-4222-8222-222222222222';
const selection = { agentId: 'claude', model: 'sonnet', apiProviderId: null, modelEndpointId: null, modelProtocol: null };

describe('ExecutorHandoffProjectState', () => {
	it('validates the confirmed path on the destination executor before resolving it', async () => {
		vi.mocked(validateStart).mockResolvedValue({ valid: true });
		const handoff = new ExecutorHandoffProjectState(() => true);
		const result = handoff.ask('chat', executorId, '/worker/project', selection);
		expect(handoff.initialProjectPath).toBe('/worker/project');
		await handoff.confirm(' /worker/worktree ');
		expect(validateStart).toHaveBeenCalledWith(' /worker/worktree ', { executorId });
		await expect(result).resolves.toEqual({ projectPath: ' /worker/worktree ', selection });
		expect(handoff.target).toBeNull();
		expect(handoff.initialProjectPath).toBe('');
	});

	it('ignores an empty destination path', async () => {
		vi.mocked(validateStart).mockClear();
		const handoff = new ExecutorHandoffProjectState(() => true);
		const pending = handoff.ask('chat', executorId, '/worker/project', selection);
		await handoff.confirm('   ');
		expect(validateStart).not.toHaveBeenCalled();
		expect(handoff.checking).toBe(false);
		handoff.cancel();
		await expect(pending).resolves.toBeNull();
	});

	it('cancels a superseded dialog and ignores its pending inspection', async () => {
		const response = Promise.withResolvers<Awaited<ReturnType<typeof validateStart>>>();
		vi.mocked(validateStart).mockReturnValue(response.promise);
		const handoff = new ExecutorHandoffProjectState(() => true);
		const first = handoff.ask('first-chat', executorId, '/worker/project', selection);
		const checking = handoff.confirm('/worker/project');
		const second = handoff.ask('second-chat', executorId, '/worker/other', selection);
		await expect(first).resolves.toBeNull();
		response.resolve({ valid: true });
		await checking;
		expect(handoff.target?.chatId).toBe('second-chat');
		expect(handoff.initialProjectPath).toBe('/worker/other');
		expect(handoff.checking).toBe(false);
		handoff.cancel();
		await expect(second).resolves.toBeNull();
	});

	it('keeps an unavailable path editable without accepting the handoff', async () => {
		vi.mocked(validateStart).mockResolvedValue({ valid: false, error: 'Directory is unavailable' });
		const handoff = new ExecutorHandoffProjectState(() => true);
		const result = handoff.ask('chat', executorId, '/missing', selection);
		await handoff.confirm('/missing');
		expect(handoff.error).toBe('Directory is unavailable');
		expect(handoff.checking).toBe(false);
		expect(handoff.target).not.toBeNull();
		handoff.cancel();
		await expect(result).resolves.toBeNull();
	});

	it('reports when the requested selection is unavailable on the destination', () => {
		let available = false;
		const handoff = new ExecutorHandoffProjectState(() => available);
		expect(handoff.selectionAvailable).toBe(true);
		const pending = handoff.ask('chat', executorId, '/worker/project', selection);
		expect(handoff.selectionAvailable).toBe(false);
		expect(handoff.canConfirm).toBe(false);
		available = true;
		expect(handoff.selectionAvailable).toBe(true);
		expect(handoff.canConfirm).toBe(true);
		handoff.cancel();
		return expect(pending).resolves.toBeNull();
	});

	it('requires an available destination and rechecks admission after path inspection', async () => {
		let ready = false;
		const handoff = new ExecutorHandoffProjectState(() => ready);
		const pending = handoff.ask('chat', executorId, '/same', selection);
		expect(handoff.canConfirm).toBe(false);
		ready = true;
		const response = Promise.withResolvers<Awaited<ReturnType<typeof validateStart>>>();
		vi.mocked(validateStart).mockReturnValue(response.promise);
		const checking = handoff.confirm('/same');
		expect(handoff.canConfirm).toBe(false);
		ready = false;
		response.resolve({ valid: true });
		await checking;
		expect(handoff.target).not.toBeNull();
		expect(handoff.error).toBe('Execution target is unavailable');
		handoff.cancel();
		await expect(pending).resolves.toBeNull();
	});
});
