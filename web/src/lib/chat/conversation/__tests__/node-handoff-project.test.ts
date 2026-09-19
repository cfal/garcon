import { describe, expect, it, vi } from 'vitest';
import { validateStart } from '$lib/api/chats';
import { NodeHandoffProjectState } from '../node-handoff-project.svelte';

vi.mock('$lib/api/chats', () => ({ validateStart: vi.fn() }));
const nodeId = '22222222-2222-4222-8222-222222222222';

describe('NodeHandoffProjectState', () => {
	it('validates the destination node before resolving a path', async () => {
		vi.mocked(validateStart).mockResolvedValue({ valid: true });
		const handoff = new NodeHandoffProjectState();
		const result = handoff.ask('chat', nodeId, '/worker/project');
		await handoff.confirm();
		expect(validateStart).toHaveBeenCalledWith('/worker/project', { nodeId });
		await expect(result).resolves.toBe('/worker/project');
		expect(handoff.target).toBeNull();
	});

	it('cancels a superseded dialog and ignores its pending inspection', async () => {
		const response = Promise.withResolvers<Awaited<ReturnType<typeof validateStart>>>();
		vi.mocked(validateStart).mockReturnValue(response.promise);
		const handoff = new NodeHandoffProjectState();
		const first = handoff.ask('first-chat', nodeId, '/worker/project');
		const checking = handoff.confirm();
		const second = handoff.ask('second-chat', nodeId, '/worker/other');
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
		const handoff = new NodeHandoffProjectState();
		const result = handoff.ask('chat', nodeId, '/missing');
		await handoff.confirm();
		expect(handoff.error).toBe('Directory is unavailable');
		expect(handoff.checking).toBe(false);
		expect(handoff.target).not.toBeNull();
		handoff.cancel();
		await expect(result).resolves.toBeNull();
	});
});
