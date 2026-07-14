import { describe, expect, it, vi } from 'vitest';
import type { CanonicalFileIdentity } from '$shared/file-contracts';
import type { FileRendererMode } from '$lib/components/files/file-session.svelte';
import { resolveFileLinkTarget } from '$lib/chat/file-link-resolver';
import type { DesktopPlacement } from '$lib/workspace/surface-types';
import type { FileOpenRequest, FilePlacementPort } from '../file-sessions.svelte';
import {
	FILE_SESSION_SOFT_LIMIT,
	FileSessionRegistry,
	type FilePlacementResult,
} from '../file-sessions.svelte';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
import { shouldWaitForFileRenderer } from '$lib/components/files/file-renderer-frame';

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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHarness(
	options: {
		placementResult?: FilePlacementResult;
		isMobile?: boolean;
		placements?: Partial<Record<FileRendererMode, DesktopPlacement>>;
		onOpenError?: (request: FileOpenRequest, error: unknown) => void;
		onPublish?: (registry: FileSessionRegistry) => void | Promise<void>;
	} = {},
) {
	const placementCalls: Array<{ sessionId: string; target: unknown }> = [];
	const focusCalls: string[] = [];
	const placement: FilePlacementPort = {
		async placeFileSession(sessionId, target, publication) {
			placementCalls.push({ sessionId, target });
			if (options.placementResult === 'cancelled') return 'cancelled';
			publication.publish();
			await options.onPublish?.(registry);
			return 'placed';
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
	const fetchContent = vi.fn(async () => new Response(new Blob(['image'])));
	const getDefaultPlacement = vi.fn(
		(mode: FileRendererMode) => options.placements?.[mode] ?? 'dialog',
	);
	const onOpenError = options.onOpenError ?? vi.fn();
	const registry = new FileSessionRegistry({
		getIsMobile: () => options.isMobile ?? false,
		getDefaultPlacement,
		getEditorSettings: () => ({
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
		fetchContent,
		onOpenError,
	});
	return {
		registry,
		placementCalls,
		focusCalls,
		resolveFileIdentity,
		readText,
		saveText,
		getDefaultPlacement,
		onOpenError,
	};
}

describe('FileSessionRegistry', () => {
	it('canonicalizes a resolved chat link with its authoritative file root', async () => {
		const harness = createHarness();
		const resolved = resolveFileLinkTarget('src/file.ts', {
			projectBasePath: '/workspace',
			chatProjectPath: '/workspace/current',
		});
		if (!resolved) throw new Error('Expected a resolved file link');

		await harness.registry.open({ ...resolved, mode: 'auto', reason: 'user-open' });

		expect(harness.resolveFileIdentity).toHaveBeenCalledWith({
			projectPath: '/workspace',
			relativePath: 'current/src/file.ts',
		});
	});

	it.each([
		['src/file.ts', 'code', 'main'],
		['assets/logo.png', 'image', 'sidebar'],
		['docs/README.md', 'markdown', 'dialog'],
	] as const)('places %s from its %s preference', async (path, mode, expected) => {
		const harness = createHarness({
			placements: { code: 'main', image: 'sidebar', markdown: 'dialog' },
		});

		await harness.registry.open(request(path));

		expect(harness.getDefaultPlacement).toHaveBeenCalledWith(mode);
		expect(harness.placementCalls[0]?.target).toBe(expected);
	});

	it('uses an explicit desktop target instead of the configured default', async () => {
		const harness = createHarness({ placements: { code: 'dialog' } });

		await harness.registry.open({ ...request('src/file.ts'), target: 'sidebar' });

		expect(harness.getDefaultPlacement).not.toHaveBeenCalled();
		expect(harness.placementCalls[0]?.target).toBe('sidebar');
	});

	it('ignores desktop placement preferences while mobile', async () => {
		const harness = createHarness({ isMobile: true, placements: { code: 'main' } });

		await harness.registry.open(request('src/mobile.ts'));

		expect(harness.getDefaultPlacement).not.toHaveBeenCalled();
		expect(harness.placementCalls[0]?.target).toBeUndefined();
	});

	it('reports identity failures without publishing a session', async () => {
		const harness = createHarness();
		const error = new Error('Not found');
		harness.resolveFileIdentity.mockRejectedValueOnce(error);

		await expect(harness.registry.open(request('missing.ts'))).resolves.toBeNull();

		expect(harness.onOpenError).toHaveBeenCalledWith(request('missing.ts'), error);
		expect(harness.registry.sessionCount).toBe(0);
		expect(harness.placementCalls).toHaveLength(0);
	});

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
		const harness = createHarness({ placementResult: 'cancelled' });
		const opened = await harness.registry.open(request('src/rejected.ts'));

		expect(opened).toBeNull();
		expect(harness.registry.sessionCount).toBe(0);
	});

	it('publishes a new session as loading before placement settles its first frame', async () => {
		let publishedLoading: boolean | null = null;
		const harness = createHarness({
			onPublish(registry) {
				publishedLoading = registry.all[0]?.loading ?? null;
			},
		});

		await harness.registry.open(request('src/loading.ts'));

		expect(publishedLoading).toBe(true);
	});

	it('reconfigures attached editors when the application theme changes', async () => {
		const harness = createHarness();
		const session = await harness.registry.open(request('src/theme.ts'));
		if (!session?.editor) throw new Error('Expected a code editor session');
		await vi.waitFor(() => expect(session.loading).toBe(false));
		const host = document.createElement('div');
		document.body.append(host);
		const lease = session.editor.attach(host);
		const editor = host.querySelector<HTMLElement>('.cm-editor');
		if (!editor) throw new Error('Expected a CodeMirror editor');
		try {
			const lightClasses = editor.className;
			harness.registry.setDarkTheme(true);
			const darkClasses = editor.className;
			expect(darkClasses).not.toBe(lightClasses);
			harness.registry.setDarkTheme(false);
			expect(editor.className).not.toBe(darkClasses);
		} finally {
			session.editor.detach(lease);
			host.remove();
		}
	});

	it('settles a loading code frame before attaching its editor after the read', async () => {
		const read = deferred<{ content: string; path: string }>();
		const bridge = new SurfaceFrameBridge();
		const attach = vi.fn();
		const harness = createHarness({
			async onPublish(registry) {
				const session = registry.all[0];
				if (!session) throw new Error('Expected a published file session');
				await bridge.activate(shouldWaitForFileRenderer(session));
			},
		});
		harness.readText.mockReturnValueOnce(read.promise);

		const opened = await harness.registry.open(request('src/slow.ts'));

		expect(opened?.loading).toBe(true);
		read.resolve({ content: 'loaded', path: '/workspace/src/slow.ts' });
		await vi.waitFor(() => expect(opened?.loading).toBe(false));
		bridge.provideRenderer({ attach, detach: vi.fn(), focusPrimary: vi.fn() });
		await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
		expect(opened?.content).toBe('loaded');
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
		for (let index = 0; index < FILE_SESSION_SOFT_LIMIT; index += 1) {
			await harness.registry.open(request(`src/file-${index}.ts`));
		}

		const firstOverLimitPath = `src/file-${FILE_SESSION_SOFT_LIMIT}.ts`;
		const firstOverLimit = harness.registry.open(request(firstOverLimitPath));
		await vi.waitFor(() =>
			expect(harness.registry.thresholdRequest?.identity.normalizedRelativePath).toBe(
				firstOverLimitPath,
			),
		);
		harness.registry.resolveThreshold('review');
		expect(harness.registry.openFilesVisible).toBe(true);
		expect(harness.registry.thresholdRequest?.identity.normalizedRelativePath).toBe(
			firstOverLimitPath,
		);

		const secondOverLimitPath = `src/file-${FILE_SESSION_SOFT_LIMIT + 1}.ts`;
		const secondOverLimit = harness.registry.open(request(secondOverLimitPath));
		harness.registry.hideOpenFiles();
		harness.registry.resolveThreshold('open');
		await expect(firstOverLimit).resolves.toBeTruthy();
		await vi.waitFor(() =>
			expect(harness.registry.thresholdRequest?.identity.normalizedRelativePath).toBe(
				secondOverLimitPath,
			),
		);
		harness.registry.resolveThreshold('cancel');
		await expect(secondOverLimit).resolves.toBeNull();
		expect(harness.registry.sessionCount).toBe(FILE_SESSION_SOFT_LIMIT + 1);
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

	it('keeps edits made during a save dirty and serializes saves per session', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		const pending = deferred<{ success: true }>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		opened.content = 'submitted';
		opened.dirty = true;

		const firstSave = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(opened.saving).toBe(true));
		opened.content = 'newer edit';
		opened.dirty = true;

		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		expect(harness.saveText).toHaveBeenCalledTimes(1);
		pending.resolve({ success: true });
		await expect(firstSave).resolves.toBe(true);

		expect(opened.baseline).toBe('submitted');
		expect(opened.content).toBe('newer edit');
		expect(opened.dirty).toBe(true);
		expect(opened.pendingMutationCount).toBe(0);

		await expect(harness.registry.save(opened.id)).resolves.toBe(true);
		expect(harness.saveText).toHaveBeenLastCalledWith({
			projectPath: '/workspace',
			filePath: 'src/file.ts',
			content: 'newer edit',
		});
		expect(opened.baseline).toBe('newer edit');
		expect(opened.dirty).toBe(false);
	});

	it('re-prompts a destructive guard when edits arrive during Save', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		const pending = deferred<{ success: true }>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		opened.content = 'submitted';
		opened.dirty = true;

		const decision = harness.registry.confirmDestructive(opened.id, 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(opened.id));
		harness.registry.resolveGuard('save');
		await vi.waitFor(() => expect(opened.saving).toBe(true));
		opened.content = 'newer edit';
		opened.dirty = true;
		pending.resolve({ success: true });

		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(opened.id));
		expect(opened.dirty).toBe(true);
		harness.registry.resolveGuard('cancel');

		await expect(decision).resolves.toBe(false);
		expect(opened.content).toBe('newer edit');
		expect(opened.dirty).toBe(true);
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
