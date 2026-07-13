import { describe, expect, it, vi } from 'vitest';
import type { CanonicalFileIdentity } from '$shared/file-contracts';
import type { FilePlacementPort } from '../file-sessions.svelte';
import { FileSessionRegistry } from '../file-sessions.svelte';

function identity(path: string): CanonicalFileIdentity {
	return {
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: path,
	};
}

function request(path: string) {
	return {
		fileRootPath: '/workspace',
		relativePath: path,
		mode: 'auto' as const,
		reason: 'user-open' as const,
	};
}

function createHarness(options: { place?: boolean } = {}) {
	const placementCalls: Array<{ sessionId: string; target: unknown }> = [];
	const focusCalls: string[] = [];
	const placement: FilePlacementPort = {
		async placeFileSession(sessionId, target, publication) {
			placementCalls.push({ sessionId, target });
			if (options.place === false) return false;
			publication.publish();
			return true;
		},
		async focusFileSession(sessionId) {
			focusCalls.push(sessionId);
		},
	};
	const resolveFileIdentity = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
		success: true as const,
		identity: identity(relativePath.replace(/^alias\//, '')),
	}));
	const readText = vi.fn(async () => ({ content: 'initial', path: '/workspace/file.ts' }));
	const saveText = vi.fn(async () => ({ success: true }));
	const registry = new FileSessionRegistry({
		getIsMobile: () => false,
		getEditorSettings: () => ({
			get isDark() {
				return false;
			},
			get wordWrap() {
				return false;
			},
			get showLineNumbers() {
				return true;
			},
			get fontSize() {
				return 12;
			},
		}),
		getPlacement: () => placement,
		resolveFileIdentity,
		readText,
		saveText,
	});
	return {
		registry,
		placementCalls,
		focusCalls,
		resolveFileIdentity,
		readText,
		saveText,
	};
}

describe('FileSessionRegistry', () => {
	it('joins concurrent canonical aliases and applies the latest requested location', async () => {
		const harness = createHarness();
		const first = harness.registry.open({ ...request('src/file.ts'), line: 2, col: 3 });
		const second = harness.registry.open({ ...request('alias/src/file.ts'), line: 8, col: 4 });
		const [firstSession, secondSession] = await Promise.all([first, second]);

		expect(firstSession).toBe(secondSession);
		expect(harness.registry.sessionCount).toBe(1);
		expect(harness.placementCalls).toHaveLength(1);
		expect(harness.focusCalls).toEqual([firstSession?.id]);
		expect(firstSession?.requestedLine).toBe(8);
		expect(firstSession?.requestedColumn).toBe(4);
	});

	it('publishes only after placement accepts the new session', async () => {
		const harness = createHarness({ place: false });
		const opened = await harness.registry.open(request('src/rejected.ts'));

		expect(opened).toBeNull();
		expect(harness.registry.sessionCount).toBe(0);
	});

	it('focuses an existing identity without moving or duplicating it', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open({ ...request('src/file.ts'), target: 'main' });
		await harness.registry.open({ ...request('src/file.ts'), target: 'sidebar', line: 12 });

		expect(harness.registry.sessionCount).toBe(1);
		expect(harness.placementCalls).toHaveLength(1);
		expect(harness.focusCalls).toEqual([opened?.id]);
		expect(opened?.requestedLine).toBe(12);
	});

	it('serializes the soft-threshold queue without overwriting requests', async () => {
		const harness = createHarness();
		for (let index = 0; index < 32; index += 1) {
			await harness.registry.open(request(`src/file-${index}.ts`));
		}

		const thirtyThird = harness.registry.open(request('src/file-32.ts'));
		await vi.waitFor(() =>
			expect(harness.registry.thresholdRequest?.identity.normalizedRelativePath).toBe(
				'src/file-32.ts',
			),
		);
		harness.registry.resolveThreshold('review');
		expect(harness.registry.openFilesVisible).toBe(true);
		expect(harness.registry.thresholdRequest?.identity.normalizedRelativePath).toBe(
			'src/file-32.ts',
		);

		const thirtyFourth = harness.registry.open(request('src/file-33.ts'));
		harness.registry.hideOpenFiles();
		harness.registry.resolveThreshold('open');
		await expect(thirtyThird).resolves.toBeTruthy();
		await vi.waitFor(() =>
			expect(harness.registry.thresholdRequest?.identity.normalizedRelativePath).toBe(
				'src/file-33.ts',
			),
		);
		harness.registry.resolveThreshold('cancel');
		await expect(thirtyFourth).resolves.toBeNull();
		expect(harness.registry.sessionCount).toBe(33);
	});

	it('queues dirty guards and preserves each decision', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/first.ts'));
		const second = await harness.registry.open(request('src/second.ts'));
		if (!first || !second) throw new Error('Expected file sessions');
		first.dirty = true;
		second.dirty = true;

		const firstDecision = harness.registry.confirmDestructive(first.id, 'close');
		const secondDecision = harness.registry.confirmDestructive(second.id, 'replace-dialog');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(first.id));
		harness.registry.resolveGuard('discard');
		await expect(firstDecision).resolves.toBe(true);
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(second.id));
		harness.registry.resolveGuard('cancel');

		await expect(secondDecision).resolves.toBe(false);
		expect(harness.registry.guardRequest).toBeNull();
	});

	it('keeps dirty content and placement state after save failure', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		opened.content = 'changed';
		opened.dirty = true;
		harness.saveText.mockRejectedValueOnce(new Error('Disk full'));

		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		expect(opened.dirty).toBe(true);
		expect(opened.content).toBe('changed');
		expect(opened.saveError).toBe('Disk full');
	});

	it('retries a failed file read without replacing the session', async () => {
		const harness = createHarness();
		harness.readText
			.mockRejectedValueOnce(new Error('Read failed'))
			.mockResolvedValueOnce({ content: 'recovered', path: '/workspace/file.ts' });
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loadError).toBe('Read failed'));

		await harness.registry.reload(opened.id);

		expect(opened.loadError).toBeNull();
		expect(opened.content).toBe('recovered');
		expect(harness.registry.get(opened.id)).toBe(opened);
	});
});
