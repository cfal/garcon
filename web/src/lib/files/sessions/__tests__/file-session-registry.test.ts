import { describe, expect, it, vi } from 'vitest';
import type { CanonicalFileIdentity, FileRevisionResponse } from '$shared/file-contracts';
import type { FileRendererMode } from '$lib/files/sessions/file-session.svelte.js';
import { resolveFileLinkTarget } from '$lib/chat/file-links/file-link-resolver.js';
import type { DesktopPlacement } from '$lib/workspace/surface-types';
import type {
	FileOpenRequest,
	FilePlacementPort,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import {
	FILE_SESSION_SOFT_LIMIT,
	FileSessionRegistry,
	type FilePlacementResult,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
import { shouldWaitForFileRenderer } from '$lib/components/files/file-renderer-frame';
import { ApiError } from '$lib/api/client.js';

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
	const readText = vi.fn(async () => ({
		content: 'initial',
		path: '/workspace/file.ts',
		revision: 'v1:initial',
	}));
	const getFileRevision = vi.fn(async (): Promise<FileRevisionResponse> => ({
		status: 'ready' as const,
		revision: 'v1:initial',
	}));
	const saveText = vi.fn(async (_params: unknown, _options?: RequestInit) => ({
		success: true as const,
		path: '/workspace/file.ts',
		message: 'saved',
		revision: 'v1:saved',
	}));
	const readContent = vi.fn(async () => ({
		blob: new Blob(['image']),
		revision: 'v1:image',
	}));
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
		getFileRevision,
		readText,
		readContent,
		saveText,
		onOpenError,
	});
	return {
		registry,
		placementCalls,
		focusCalls,
		resolveFileIdentity,
		getFileRevision,
		readText,
		readContent,
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
		const read = deferred<{ content: string; path: string; revision: string }>();
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
		read.resolve({
			content: 'loaded',
			path: '/workspace/src/slow.ts',
			revision: 'v1:loaded',
		});
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

	it('cancels an owned guard when its session is destroyed', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/first.ts'));
		const second = await harness.registry.open(request('src/second.ts'));
		if (!first || !second) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));
		first.content = 'first local';
		first.dirty = true;
		second.content = 'second local';
		second.dirty = true;

		const firstDecision = harness.registry.confirmDestructive(first.id, 'refresh');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(first.id));
		harness.registry.destroy(first.id);
		await expect(firstDecision).resolves.toBe(false);

		const secondDecision = harness.registry.confirmDestructive(second.id, 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(second.id));
		harness.registry.resolveGuard('discard');
		await expect(secondDecision).resolves.toBe(true);
	});

	it('keeps dirty content and placement state after save failure', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
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
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const pending = deferred<{
			success: true;
			path: string;
			message: string;
			revision: string;
		}>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		opened.content = 'submitted';
		opened.dirty = true;

		const firstSave = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(opened.saving).toBe(true));
		opened.content = 'newer edit';
		opened.dirty = true;

		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		expect(harness.saveText).toHaveBeenCalledTimes(1);
		pending.resolve({
			success: true,
			path: '/workspace/src/file.ts',
			message: 'saved',
			revision: 'v1:first-save',
		});
		await expect(firstSave).resolves.toBe(true);

		expect(opened.baseline).toBe('submitted');
		expect(opened.content).toBe('newer edit');
		expect(opened.dirty).toBe(true);
		expect(opened.pendingMutationCount).toBe(0);

		await expect(harness.registry.save(opened.id)).resolves.toBe(true);
		expect(harness.saveText).toHaveBeenLastCalledWith(
			{
				projectPath: '/workspace',
				filePath: 'src/file.ts',
				content: 'newer edit',
				expectedRevision: 'v1:first-save',
				conflictResolution: 'reject',
			},
			{ signal: expect.any(AbortSignal) },
		);
		expect(opened.baseline).toBe('newer edit');
		expect(opened.dirty).toBe(false);
	});

	it('aborts an in-flight save when its session is destroyed', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const pending = deferred<{
			success: true;
			path: string;
			message: string;
			revision: string;
		}>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		opened.content = 'submitted';
		opened.dirty = true;

		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.saveText).toHaveBeenCalledOnce());
		const signal = harness.saveText.mock.calls[0]?.[1]?.signal;
		expect(signal).toBeInstanceOf(AbortSignal);
		harness.registry.destroy(opened.id);
		expect(signal?.aborted).toBe(true);
		pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));

		await expect(save).resolves.toBe(false);
		expect(opened.saveError).toBeNull();
	});

	it('ignores a freshness response that started before save', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const freshness = deferred<{ status: 'ready'; revision: string }>();
		harness.getFileRevision.mockReturnValueOnce(freshness.promise);
		const check = harness.registry.checkFreshness(opened.id);
		await vi.waitFor(() => expect(opened.isCheckingFreshness).toBe(true));
		opened.content = 'submitted';
		opened.dirty = true;

		await expect(harness.registry.save(opened.id)).resolves.toBe(true);
		freshness.resolve({ status: 'ready', revision: 'v1:initial' });
		await check;

		expect(opened.loadedRevision).toBe('v1:saved');
		expect(opened.isExternallyStale).toBe(false);
	});

	it('re-prompts a destructive guard when edits arrive during Save', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const pending = deferred<{
			success: true;
			path: string;
			message: string;
			revision: string;
		}>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		opened.content = 'submitted';
		opened.dirty = true;

		const decision = harness.registry.confirmDestructive(opened.id, 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(opened.id));
		harness.registry.resolveGuard('save');
		await vi.waitFor(() => expect(opened.saving).toBe(true));
		opened.content = 'newer edit';
		opened.dirty = true;
		pending.resolve({
			success: true,
			path: '/workspace/src/file.ts',
			message: 'saved',
			revision: 'v1:guard-save',
		});

		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(opened.id));
		expect(opened.dirty).toBe(true);
		harness.registry.resolveGuard('cancel');

		await expect(decision).resolves.toBe(false);
		expect(opened.content).toBe('newer edit');
		expect(opened.dirty).toBe(true);
	});

	it('stores the anchored revision from the initial load', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');

		await vi.waitFor(() => expect(opened.loading).toBe(false));
		expect(opened.loadedRevision).toBe('v1:initial');
		expect(opened.isExternallyStale).toBe(false);
	});

	it('marks only the changed session stale', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/first.ts'));
		const second = await harness.registry.open(request('src/second.ts'));
		if (!first || !second) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));
		harness.getFileRevision.mockResolvedValueOnce({
			status: 'ready',
			revision: 'v1:external',
		});

		await harness.registry.checkFreshness(first.id);

		expect(first.isExternallyStale).toBe(true);
		expect(second.isExternallyStale).toBe(false);
		await harness.registry.checkFreshness(first.id);
		expect(harness.getFileRevision).toHaveBeenCalledTimes(1);
	});

	it('treats deletion as stale without turning polling errors into changes', async () => {
		const harness = createHarness();
		const missing = await harness.registry.open(request('src/missing.ts'));
		const offline = await harness.registry.open(request('src/offline.ts'));
		if (!missing || !offline) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(missing.loading || offline.loading).toBe(false));
		harness.getFileRevision
			.mockResolvedValueOnce({ status: 'missing' })
			.mockRejectedValueOnce(new Error('offline'));

		await harness.registry.checkFreshness(missing.id);
		await harness.registry.checkFreshness(offline.id);

		expect(missing.isExternallyStale).toBe(true);
		expect(offline.isExternallyStale).toBe(false);
		expect(offline.freshnessError).toBe('offline');
	});

	it('keeps current content mounted while a refresh loads the latest revision', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const refreshed = deferred<{ content: string; path: string; revision: string }>();
		harness.readText.mockReturnValueOnce(refreshed.promise);
		opened.isExternallyStale = true;

		const refresh = harness.registry.refresh(opened.id);
		await vi.waitFor(() => expect(opened.refreshing).toBe(true));
		expect(opened.loading).toBe(false);
		expect(opened.content).toBe('initial');
		refreshed.resolve({
			content: 'external',
			path: '/workspace/src/file.ts',
			revision: 'v1:external',
		});
		await refresh;

		expect(opened.content).toBe('external');
		expect(opened.loadedRevision).toBe('v1:external');
		expect(opened.isExternallyStale).toBe(false);
		expect(opened.refreshing).toBe(false);
	});

	it('preserves edits made during refresh and blocks a concurrent save', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const refreshed = deferred<{ content: string; path: string; revision: string }>();
		harness.readText.mockReturnValueOnce(refreshed.promise);

		const refresh = harness.registry.refresh(opened.id);
		await vi.waitFor(() => expect(opened.refreshing).toBe(true));
		opened.content = 'typed while refreshing';
		opened.dirty = true;
		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		expect(harness.saveText).not.toHaveBeenCalled();

		refreshed.resolve({
			content: 'external',
			path: '/workspace/src/file.ts',
			revision: 'v1:external',
		});
		await refresh;

		expect(opened.content).toBe('typed while refreshing');
		expect(opened.dirty).toBe(true);
		expect(opened.loadedRevision).toBe('v1:initial');
		expect(opened.isExternallyStale).toBe(true);
	});

	it('retains stale content and reports a refresh failure', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.isExternallyStale = true;
		harness.readText.mockRejectedValueOnce(new Error('refresh failed'));

		await harness.registry.refresh(opened.id);

		expect(opened.content).toBe('initial');
		expect(opened.loadedRevision).toBe('v1:initial');
		expect(opened.isExternallyStale).toBe(true);
		expect(opened.refreshError).toBe('refresh failed');
	});

	it('requires confirmation before a dirty refresh discards local edits', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		opened.dirty = true;

		const cancelled = harness.registry.refresh(opened.id);
		await vi.waitFor(() => expect(harness.registry.guardRequest?.reason).toBe('refresh'));
		harness.registry.resolveGuard('cancel');
		await cancelled;
		expect(harness.readText).toHaveBeenCalledTimes(1);
		expect(opened.content).toBe('local');

		const confirmed = harness.registry.refresh(opened.id);
		await vi.waitFor(() => expect(harness.registry.guardRequest?.reason).toBe('refresh'));
		harness.registry.resolveGuard('discard');
		await confirmed;
		expect(opened.content).toBe('initial');
		expect(opened.dirty).toBe(false);
	});

	it('keeps a stale dirty editor when overwrite confirmation is cancelled', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		opened.dirty = true;
		harness.saveText.mockRejectedValueOnce(
			new ApiError(409, 'File changed on disk', 'FILE_REVISION_CONFLICT'),
		);

		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.sessionId).toBe(opened.id));
		harness.registry.resolveOverwrite('cancel');

		await expect(save).resolves.toBe(false);
		expect(opened.content).toBe('local');
		expect(opened.dirty).toBe(true);
		expect(opened.isExternallyStale).toBe(true);
		expect(opened.saveError).toBeNull();
	});

	it('confirms an already-stale save before sending one overwrite request', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		opened.dirty = true;
		opened.isExternallyStale = true;

		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.sessionId).toBe(opened.id));
		expect(harness.saveText).not.toHaveBeenCalled();
		harness.registry.resolveOverwrite('overwrite');

		await expect(save).resolves.toBe(true);
		expect(harness.saveText).toHaveBeenCalledOnce();
		expect(harness.saveText).toHaveBeenCalledWith(
			{
				projectPath: '/workspace',
				filePath: 'src/file.ts',
				content: 'local',
				expectedRevision: 'v1:initial',
				conflictResolution: 'overwrite',
			},
			{ signal: expect.any(AbortSignal) },
		);
	});

	it('retries one captured snapshot after explicit overwrite confirmation', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		opened.dirty = true;
		harness.saveText.mockRejectedValueOnce(
			new ApiError(409, 'File changed on disk', 'FILE_REVISION_CONFLICT'),
		);

		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.sessionId).toBe(opened.id));
		harness.registry.resolveOverwrite('overwrite');
		await expect(save).resolves.toBe(true);

		expect(harness.saveText).toHaveBeenCalledTimes(2);
		expect(harness.saveText).toHaveBeenLastCalledWith(
			{
				projectPath: '/workspace',
				filePath: 'src/file.ts',
				content: 'local',
				expectedRevision: 'v1:initial',
				conflictResolution: 'overwrite',
			},
			{ signal: expect.any(AbortSignal) },
		);
		expect(opened.loadedRevision).toBe('v1:saved');
		expect(opened.isExternallyStale).toBe(false);
		expect(opened.dirty).toBe(false);
	});

	it('serializes overwrite dialogs across independent sessions', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/first.ts'));
		const second = await harness.registry.open(request('src/second.ts'));
		if (!first || !second) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));
		first.content = 'first local';
		first.dirty = true;
		second.content = 'second local';
		second.dirty = true;
		const conflict = () =>
			new ApiError(409, 'File changed on disk', 'FILE_REVISION_CONFLICT');
		harness.saveText.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());

		const firstSave = harness.registry.save(first.id);
		const secondSave = harness.registry.save(second.id);
		await vi.waitFor(() =>
			expect(harness.registry.overwriteRequest?.sessionId).toBe(first.id),
		);
		harness.registry.resolveOverwrite('cancel');
		await vi.waitFor(() =>
			expect(harness.registry.overwriteRequest?.sessionId).toBe(second.id),
		);
		harness.registry.resolveOverwrite('overwrite');

		await expect(firstSave).resolves.toBe(false);
		await expect(secondSave).resolves.toBe(true);
		expect(harness.registry.overwriteRequest).toBeNull();
		expect(first.isExternallyStale).toBe(true);
		expect(second.isExternallyStale).toBe(false);
	});

	it('serializes dirty guards and overwrite confirmations through one dialog queue', async () => {
		const harness = createHarness();
		const guarded = await harness.registry.open(request('src/guarded.ts'));
		const saving = await harness.registry.open(request('src/saving.ts'));
		if (!guarded || !saving) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(guarded.loading || saving.loading).toBe(false));
		guarded.content = 'guarded local';
		guarded.dirty = true;
		saving.content = 'saving local';
		saving.dirty = true;
		const pendingSave = deferred<{
			success: true;
			path: string;
			message: string;
			revision: string;
		}>();
		harness.saveText.mockReturnValueOnce(pendingSave.promise);
		const save = harness.registry.save(saving.id);
		await vi.waitFor(() => expect(saving.saving).toBe(true));
		const refresh = harness.registry.refresh(guarded.id);
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(guarded.id));

		pendingSave.reject(new ApiError(409, 'File changed on disk', 'FILE_REVISION_CONFLICT'));
		await Promise.resolve();
		expect(harness.registry.overwriteRequest).toBeNull();

		harness.registry.resolveGuard('cancel');
		await refresh;
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.sessionId).toBe(saving.id));
		expect(harness.registry.guardRequest).toBeNull();
		harness.registry.resolveOverwrite('cancel');
		await expect(save).resolves.toBe(false);
	});

	it('stores image revisions and swaps image content only after refresh succeeds', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('assets/logo.png'));
		if (!opened) throw new Error('Expected image session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const initialUrl = opened.imageObjectUrl;
		expect(opened.loadedRevision).toBe('v1:image');
		harness.readContent.mockResolvedValueOnce({
			blob: new Blob(['updated']),
			revision: 'v1:updated-image',
		});
		opened.isExternallyStale = true;

		await harness.registry.refresh(opened.id);

		expect(opened.loadedRevision).toBe('v1:updated-image');
		expect(opened.imageObjectUrl).not.toBe(initialUrl);
		expect(opened.isExternallyStale).toBe(false);
	});

	it('ignores a destroyed image refresh without creating an abandoned URL', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('assets/logo.png'));
		if (!opened) throw new Error('Expected image session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const pending = deferred<{ blob: Blob; revision: string }>();
		harness.readContent.mockReturnValueOnce(pending.promise);
		const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
		const callsBeforeRefresh = createObjectUrl.mock.calls.length;

		const refresh = harness.registry.refresh(opened.id);
		await vi.waitFor(() => expect(opened.refreshing).toBe(true));
		harness.registry.destroy(opened.id);
		pending.resolve({ blob: new Blob(['abandoned']), revision: 'v1:abandoned' });
		await refresh;

		expect(harness.registry.get(opened.id)).toBeNull();
		expect(createObjectUrl).toHaveBeenCalledTimes(callsBeforeRefresh);
		createObjectUrl.mockRestore();
	});

	it('deduplicates concurrent refresh requests for one session', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const pending = deferred<{ content: string; path: string; revision: string }>();
		harness.readText.mockReturnValueOnce(pending.promise);

		const first = harness.registry.refresh(opened.id);
		await vi.waitFor(() => expect(opened.refreshing).toBe(true));
		await harness.registry.refresh(opened.id);
		expect(harness.readText).toHaveBeenCalledTimes(2);
		pending.resolve({
			content: 'latest',
			path: '/workspace/src/file.ts',
			revision: 'v1:latest',
		});
		await first;
	});

	it('ignores an older freshness response after refresh begins', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const freshness = deferred<{ status: 'ready'; revision: string }>();
		harness.getFileRevision.mockReturnValueOnce(freshness.promise);
		const check = harness.registry.checkFreshness(opened.id);
		await vi.waitFor(() => expect(opened.isCheckingFreshness).toBe(true));
		harness.readText.mockResolvedValueOnce({
			content: 'refreshed',
			path: '/workspace/src/file.ts',
			revision: 'v1:refreshed',
		});

		await harness.registry.refresh(opened.id);
		freshness.resolve({ status: 'ready', revision: 'v1:older-response' });
		await check;

		expect(opened.loadedRevision).toBe('v1:refreshed');
		expect(opened.isExternallyStale).toBe(false);
	});

	it('retries a failed file read without replacing the session', async () => {
		const harness = createHarness();
		harness.readText
			.mockRejectedValueOnce(new Error('Read failed'))
			.mockResolvedValueOnce({
				content: 'recovered',
				path: '/workspace/file.ts',
				revision: 'v1:recovered',
			});
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loadError).toBe('Read failed'));

		await harness.registry.reload(opened.id);

		expect(opened.loadError).toBeNull();
		expect(opened.content).toBe('recovered');
		expect(harness.registry.get(opened.id)).toBe(opened);
	});
});
