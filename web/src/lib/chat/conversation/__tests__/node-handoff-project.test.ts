import { describe, expect, it, vi } from 'vitest';
import { validateStart } from '$lib/api/chats';
import { NodeHandoffProjectState } from '../node-handoff-project.svelte';

vi.mock('$lib/api/chats', () => ({ validateStart: vi.fn() }));
const nodeId = '22222222-2222-4222-8222-222222222222';
const selection = { agentId: 'claude', model: 'sonnet', apiProviderId: null, modelEndpointId: null, modelProtocol: null };

describe('NodeHandoffProjectState', () => {
	it('validates the destination node before resolving a path', async () => {
		vi.mocked(validateStart).mockResolvedValue({ valid: true });
		const handoff = new NodeHandoffProjectState(() => true);
		const result = handoff.ask('chat', nodeId, '/worker/project', selection);
		await handoff.confirm();
		expect(validateStart).toHaveBeenCalledWith('/worker/project', { nodeId });
		await expect(result).resolves.toEqual({ projectPath: '/worker/project', selection });
		expect(handoff.target).toBeNull();
	});

	it('cancels a superseded dialog and ignores its pending inspection', async () => {
		const response = Promise.withResolvers<Awaited<ReturnType<typeof validateStart>>>();
		vi.mocked(validateStart).mockReturnValue(response.promise);
		const handoff = new NodeHandoffProjectState(() => true);
		const first = handoff.ask('first-chat', nodeId, '/worker/project', selection);
		const checking = handoff.confirm();
		const second = handoff.ask('second-chat', nodeId, '/worker/other', selection);
		await expect(first).resolves.toBeNull();
		response.resolve({ valid: true });
		await checking;
		expect(handoff.target?.chatId).toBe('second-chat');
		expect(handoff.projectPath).toBe('/worker/other');
		handoff.cancel();
		await expect(second).resolves.toBeNull();
	});

	it('keeps an unavailable path editable without accepting the handoff', async () => {
		vi.mocked(validateStart).mockResolvedValue({ valid: false, error: 'Directory is unavailable' });
		const handoff = new NodeHandoffProjectState(() => true);
		const result = handoff.ask('chat', nodeId, '/missing', selection);
		await handoff.confirm();
		expect(handoff.error).toBe('Directory is unavailable');
		expect(handoff.checking).toBe(false);
		expect(handoff.target).not.toBeNull();
		handoff.cancel();
		await expect(result).resolves.toBeNull();
	});

	it('requires a validated destination and rechecks admission after path inspection', async () => {
		let ready = false;
		const handoff = new NodeHandoffProjectState(() => ready);
		const pending = handoff.ask('chat', nodeId, '/same', selection);
		expect(handoff.canConfirm).toBe(false);
		ready = true;
		const response = Promise.withResolvers<Awaited<ReturnType<typeof validateStart>>>();
		vi.mocked(validateStart).mockReturnValue(response.promise);
		const checking = handoff.confirm();
		ready = false;
		response.resolve({ valid: true });
		await checking;
		expect(handoff.target).not.toBeNull();
		expect(handoff.error).toBe('Execution target is unavailable');
		handoff.cancel();
		await expect(pending).resolves.toBeNull();
	});
});
