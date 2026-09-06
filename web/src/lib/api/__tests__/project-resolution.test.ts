import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProject } from '../project-resolution';

const CHAT_ID = '1783725900000800';

describe('project resolution API', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		localStorage.setItem('garcon-token', 'test-token');
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('encodes a fenced chat target and parses its response', async () => {
		const target = { kind: 'chat', chatId: CHAT_ID, projectPath: '/workspace/project a' } as const;
		fetchMock.mockResolvedValue(new Response(JSON.stringify({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/real/project-a' },
		}), { headers: { 'Content-Type': 'application/json' } }));

		await expect(resolveProject(target, new AbortController().signal)).resolves.toEqual({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/real/project-a' },
		});
		expect(fetchMock.mock.calls[0]?.[0]).toContain(
			`chatId=${CHAT_ID}&expectedProjectPath=%2Fworkspace%2Fproject+a`,
		);
	});

	it('rejects a valid response for a different target', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({
			target: { kind: 'path', projectPath: '/workspace/other' },
			resolution: { kind: 'unavailable', reason: 'not-found' },
		}), { headers: { 'Content-Type': 'application/json' } }));

		await expect(resolveProject(
			{ kind: 'path', projectPath: '/workspace/project' },
			new AbortController().signal,
		)).rejects.toThrow('Invalid project resolution response');
	});
});
