import { describe, expect, it, vi } from 'vitest';
import { undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import type { CanonicalFileIdentity, FileRevisionResponse } from '$shared/file-contracts';
import type { FileRendererMode } from '$lib/files/sessions/file-view-session.svelte.js';
import { resolveFileLinkTarget } from '$lib/chat/file-links/file-link-resolver.js';
import type { DesktopPlacement, PresentationHostId } from '$lib/workspace/surface-types';
import type {
	FileOpenRequest,
	FilePlacementPort,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import {
	FILE_SESSION_SOFT_LIMIT,
	FileSessionRegistry,
	type FileEditorRuntimeModule,
	type FilePlacementResult,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
import { shouldWaitForFileRenderer } from '$lib/components/files/file-renderer-frame';
import { ApiError } from '$lib/api/client.js';
import { ModuleImportError } from '$lib/utils/module-import-error.js';
import { FileDocumentRuntime } from '$lib/files/editor/file-document-runtime.js';
import {
	createMemoryFileDraftRepository,
	type SpaFileDraftV1,
	type SpaFileViewV1,
} from '$lib/files/persistence/file-draft-repository.js';

const testEditorRuntime: FileEditorRuntimeModule =
	await import('$lib/files/editor/code-editor-controller.svelte.js');

function identity(path: string): CanonicalFileIdentity {
	return {
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: path,
	};
}

function request(path: string, origin: PresentationHostId = 'window-main'): FileOpenRequest {
	return {
		fileRootPath: '/workspace',
		relativePath: path,
		mode: 'auto' as const,
		origin,
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

function editorRuntime(): Promise<FileEditorRuntimeModule> {
	return Promise.resolve(testEditorRuntime);
}

function storedDraft(
	overrides: Partial<SpaFileDraftV1> &
		Pick<SpaFileDraftV1, 'documentId' | 'normalizedRelativePath' | 'content'>,
): SpaFileDraftV1 {
	return {
		schemaVersion: 1,
		deploymentId: 'test-deployment',
		userNamespace: 'test-user',
		browserSessionId: 'test-session',
		canonicalFileRootPath: '/workspace',
		diskRevision: 'v1:initial',
		baselineContent: 'initial',
		bufferVersion: 1,
		savedAt: 1,
		generation: 1,
		unknownSubmission: null,
		closed: false,
		...overrides,
		displayPath: overrides.displayPath ?? overrides.normalizedRelativePath,
	};
}

function storedView(
	overrides: Partial<SpaFileViewV1> &
		Pick<SpaFileViewV1, 'viewId' | 'documentId' | 'normalizedRelativePath'>,
): SpaFileViewV1 {
	return {
		schemaVersion: 1,
		deploymentId: 'test-deployment',
		userNamespace: 'test-user',
		browserSessionId: 'test-session',
		canonicalFileRootPath: '/workspace',
		rendererMode: 'code',
		line: 1,
		column: 1,
		endLine: 1,
		endColumn: 1,
		scrollLeft: 0,
		scrollTop: 0,
		folds: [],
		updatedAt: 1,
		placement: 'window-main',
		...overrides,
	};
}

function createHarness(
	options: {
		placementResult?: FilePlacementResult;
		isMobile?: boolean;
		placements?: Partial<Record<FileRendererMode, DesktopPlacement>>;
		onOpenError?: (request: FileOpenRequest, error: unknown) => void;
		onRecoveryError?: import('$lib/files/sessions/file-session-registry.svelte.js').FileSessionsDeps['onRecoveryError'];
		onPublish?: (registry: FileSessionRegistry) => void | Promise<void>;
		loadEditorRuntime?: () => Promise<FileEditorRuntimeModule>;
		reloadApplication?: () => void;
		draftRepository?: import('$lib/files/persistence/file-draft-repository.js').FileDraftRepository;
		saveSoftTimeoutMs?: number;
		placement?: FilePlacementPort;
		userNamespace?: string | null;
		isDocumentVisible?: (documentId: string) => boolean;
	} = {},
) {
	const placementCalls: Array<{ sessionId: string; target: unknown }> = [];
	const focusCalls: string[] = [];
	const defaultPlacement: FilePlacementPort = {
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
	const placement = options.placement ?? defaultPlacement;
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
		(mode: FileRendererMode, _origin: PresentationHostId) =>
			options.placements?.[mode] ?? ({ type: 'dialog' } as const),
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
		draftRepository: options.draftRepository ?? createMemoryFileDraftRepository(),
		deploymentId: 'test-deployment',
		resolveFileIdentity,
		getFileRevision,
		readText,
		readContent,
		saveText,
		loadEditorRuntime: options.loadEditorRuntime,
		reloadApplication: options.reloadApplication,
		saveSoftTimeoutMs: options.saveSoftTimeoutMs,
		onOpenError,
		onRecoveryError: options.onRecoveryError,
		isDocumentVisible: options.isDocumentVisible,
	});
	const userNamespace = options.userNamespace === undefined ? 'test-user' : options.userNamespace;
	if (userNamespace) void registry.initializeRecovery(userNamespace, 'test-session');
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
	it('checkpoints edits made before authenticated recovery initialization', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository, userNamespace: null });
		const opened = (await harness.registry.open(request('early.txt')))!;
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'early edit';
		await harness.registry.initializeRecovery('test-user', 'test-session');
		await harness.registry.flushRecovery();
		expect(
			(await repository.getDrafts('test-user', 'test-deployment', 'test-session'))[0]?.content,
		).toBe('early edit');
		await harness.registry.destroyAll();
	});

	it('reports a failed teardown checkpoint outside the disposed file surface', async () => {
		const repository = createMemoryFileDraftRepository();
		const onRecoveryError = vi.fn();
		const harness = createHarness({ draftRepository: repository, onRecoveryError });
		const opened = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'unsaved edit';
		const error = new Error('quota exceeded');
		vi.spyOn(repository, 'putDraft').mockRejectedValue(error);
		await harness.registry.destroyAll();
		expect(onRecoveryError).toHaveBeenCalledWith(opened.document, error);
	});

	it('provides an actionable message for an empty recovery failure', async () => {
		const repository = createMemoryFileDraftRepository();
		vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error(''));
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = (await harness.registry.open(request('file.txt')))!;
		expect(opened.document.recoveryGuard).toBe(true);
		expect(opened.document.recoveryDiscoveryError).toBeTruthy();
		await harness.registry.retryRecoveryDiscovery();
		expect(opened.document.recoveryGuard).toBe(false);
		await harness.registry.destroyAll();
	});

	it('refuses recovery cleanup while clean alternate copies need a decision', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository });
		const opened = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.document.recoveredCopies = [
			{ id: 'clean-copy', content: 'initial', savedAt: 1, hasUnknownSubmission: false },
		];
		const clear = vi.spyOn(repository, 'clearNamespaceIfUnprotected');
		await expect(harness.registry.clearRecovery()).resolves.toBe(false);
		expect(clear).not.toHaveBeenCalled();
		expect(opened.document.recoveredCopies).toHaveLength(1);
		await harness.registry.destroyAll();
	});
	it('does not offer a previous disk snapshot after a comparison read fails', async () => {
		const harness = createHarness();
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'local';
		harness.readText.mockResolvedValueOnce({
			content: 'disk two',
			revision: 'v1:two',
			path: '/workspace/file.txt',
		});
		const first = harness.registry.showConflict(session.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.diskRevision).toBe('v1:two'));
		harness.registry.resolveOverwrite('cancel');
		await first;
		harness.readText.mockRejectedValueOnce(new Error('disk unavailable'));
		await harness.registry.showConflict(session.id);
		expect(harness.registry.overwriteRequest).toBeNull();
		expect(session.document.diskRevision).toBeNull();
		expect(session.document.diskContent).toBeNull();
		expect(session.refreshError).toBe('disk unavailable');
		expect(harness.saveText).not.toHaveBeenCalled();
		await harness.registry.destroyAll();
	});

	it('ignores a superseded comparison read even when it ignores abort', async () => {
		const harness = createHarness();
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'local';
		const old = deferred<Awaited<ReturnType<typeof harness.readText>>>();
		harness.readText.mockReturnValueOnce(old.promise);
		const first = harness.registry.showConflict(session.id);
		harness.readText.mockResolvedValueOnce({
			content: 'disk three',
			revision: 'v1:three',
			path: '/workspace/file.txt',
		});
		const second = harness.registry.showConflict(session.id);
		await vi.waitFor(() =>
			expect(harness.registry.overwriteRequest?.diskRevision).toBe('v1:three'),
		);
		harness.registry.resolveOverwrite('cancel');
		await second;
		old.resolve({ content: 'disk two', revision: 'v1:two', path: '/workspace/file.txt' });
		await first;
		expect(harness.registry.overwriteRequest).toBeNull();
		expect(session.document.diskRevision).toBe('v1:three');
		await harness.registry.destroyAll();
	});

	it.each(['refresh', 'reload'] as const)(
		'guards %s of a dirty recovered buffer without a stored revision',
		async (action) => {
			const repository = createMemoryFileDraftRepository();
			const harness = createHarness({ draftRepository: repository });
			const session = (await harness.registry.open(request('file.txt')))!;
			await vi.waitFor(() => expect(session.loading).toBe(false));
			session.document.loadedRevision = null;
			session.document.recovered = true;
			session.content = 'recovered edit';
			harness.readText.mockClear();
			const refresh = harness.registry[action](session.id);
			await vi.waitFor(() => expect(harness.registry.guardRequest?.reason).toBe('refresh'));
			harness.registry.resolveGuard('cancel');
			await refresh;
			expect(session.content).toBe('recovered edit');
			expect(harness.readText).not.toHaveBeenCalled();
			await harness.registry.flushRecovery();
			expect(
				(await repository.getDrafts('test-user', 'test-deployment', 'test-session'))[0]?.content,
			).toBe('recovered edit');
			await harness.registry.destroyAll();
		},
	);

	it('reports a recovery guard raised while Accept disk is awaiting a decision', async () => {
		const harness = createHarness();
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'local';
		const comparison = harness.registry.showConflict(session.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest).not.toBeNull());
		session.document.recoveryGuard = true;
		harness.registry.resolveOverwrite('accept-disk');
		await comparison;
		expect(session.content).toBe('local');
		expect(session.saveError).toBeTruthy();
		await harness.registry.destroyAll();
	});
	it.each(['saved', 'rejected', 'detached'] as const)(
		'releases only its own Save reservation after %s',
		async (outcome) => {
			const harness = createHarness({ saveSoftTimeoutMs: 5 });
			const opened = await harness.registry.open(request('reservation.ts'));
			if (!opened) throw new Error('Expected file');
			await vi.waitFor(() => expect(opened.loading).toBe(false));
			opened.content = 'local';
			const pending = deferred<Awaited<ReturnType<typeof harness.saveText>>>();
			harness.saveText.mockReturnValueOnce(pending.promise);
			const save = harness.registry.save(opened.id);
			await vi.waitFor(() => expect(harness.saveText).toHaveBeenCalledOnce());
			opened.pendingMutationCount += 1;
			if (outcome === 'detached') await expect(save).resolves.toBe(false);
			if (outcome === 'rejected') pending.reject(new ApiError(401, 'not authenticated'));
			else
				pending.resolve({
					success: true,
					path: '/workspace/reservation.ts',
					message: 'saved',
					revision: 'v1:saved',
				});
			await save;
			await vi.waitFor(() => expect(opened.saveController).toBeNull());
			expect(opened.pendingMutationCount).toBe(1);
			expect(opened.document.mutationGuarded).toBe(true);
			opened.pendingMutationCount -= 1;
			await harness.registry.destroyAll();
		},
	);

	it('admits application reload only when every document is clean and Saves have settled', async () => {
		const reloadApplication = vi.fn();
		const { registry } = createHarness({ reloadApplication });
		try {
			const first = await registry.open(request('first.txt'));
			const second = await registry.open(request('second.txt'));
			if (!first || !second) throw new Error('Expected two open views');
			await vi.waitFor(() => expect(second.loadedRevision).toBe('v1:initial'));
			first.document.applyUserEdit('unsaved');
			registry.reloadApplication();
			expect(reloadApplication).not.toHaveBeenCalled();
			expect(first.document.currentContent()).toBe('unsaved');
			first.document.applyUserEdit(first.baseline);
			for (const outcome of ['preparing', 'saving', 'settling', 'unknown'] as const) {
				first.document.saveOutcome = outcome;
				registry.reloadApplication();
				expect(reloadApplication).not.toHaveBeenCalled();
			}
			const publishedViews = registry.sessions;
			registry.sessions = { [second.id]: second };
			registry.reloadApplication();
			expect(reloadApplication).not.toHaveBeenCalled();
			first.document.saveOutcome = 'idle';
			registry.reloadApplication();
			expect(reloadApplication).toHaveBeenCalledOnce();
			registry.sessions = publishedViews;
		} finally {
			await registry.destroyAll();
		}
	});
	it('canonicalizes a resolved chat link with its authoritative file root', async () => {
		const harness = createHarness();
		const resolved = resolveFileLinkTarget('src/file.ts', {
			fileRootPath: '/workspace',
			sourceDirectoryPath: '/workspace/current',
		});
		if (!resolved) throw new Error('Expected a resolved file link');

		await harness.registry.open({
			...resolved,
			mode: 'auto',
			origin: 'window-main',
			reason: 'user-open',
		});

		expect(harness.resolveFileIdentity).toHaveBeenCalledWith({
			projectPath: '/workspace',
			relativePath: 'current/src/file.ts',
		});
	});

	it.each([
		['src/file.ts', 'code', 'window-main', { type: 'window', windowId: 'window-main' }],
		['assets/logo.png', 'image', 'window-sidebar', { type: 'window', windowId: 'window-sidebar' }],
		['docs/README.md', 'markdown', 'dialog', { type: 'dialog' }],
	] as const)('forwards %s as %s from %s origin', async (path, mode, origin, expected) => {
		const harness = createHarness({
			placements: {
				code: { type: 'window', windowId: 'window-main' },
				image: { type: 'window', windowId: 'window-sidebar' },
				markdown: { type: 'dialog' },
			},
		});

		await harness.registry.open(request(path, origin));

		expect(harness.getDefaultPlacement).toHaveBeenCalledWith(mode, origin);
		expect(harness.placementCalls[0]?.target).toEqual(expected);
	});

	it('uses an explicit desktop target instead of the configured default', async () => {
		const harness = createHarness({ placements: { code: { type: 'dialog' } } });

		await harness.registry.open({
			...request('src/file.ts'),
			target: { type: 'window', windowId: 'window-sidebar' },
		});

		expect(harness.getDefaultPlacement).not.toHaveBeenCalled();
		expect(harness.placementCalls[0]?.target).toEqual({
			type: 'window',
			windowId: 'window-sidebar',
		});
	});

	it('ignores desktop placement preferences while mobile', async () => {
		const harness = createHarness({
			isMobile: true,
			placements: { code: { type: 'window', windowId: 'window-main' } },
		});

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
		const first = harness.registry.open({
			...request('src/file.ts', 'window-main'),
			line: 2,
			col: 3,
		});
		const second = harness.registry.open({
			...request('alias/src/file.ts', 'window-sidebar'),
			line: 8,
			col: 4,
		});
		const [firstSession, secondSession] = await Promise.all([first, second]);

		expect(firstSession).toBe(secondSession);
		expect(harness.registry.sessionCount).toBe(1);
		expect(harness.placementCalls).toHaveLength(1);
		expect(harness.getDefaultPlacement).toHaveBeenCalledOnce();
		expect(harness.getDefaultPlacement).toHaveBeenCalledWith('code', 'window-main');
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
		if (!session) throw new Error('Expected a code editor session');
		await vi.waitFor(() => expect(session.loading).toBe(false));
		if (!session.editor) throw new Error('Expected a loaded code editor');
		const host = document.createElement('div');
		document.body.append(host);
		const lease = session.editor.attach(host);
		const editor = host.querySelector<HTMLElement>('.cm-editor');
		if (!editor) throw new Error('Expected a CodeMirror editor');
		try {
			const lightClasses = editor.className;
			harness.registry.setThemePresentation({
				colorScheme: 'dark',
				rendererPalette: 'standard',
			});
			const darkClasses = editor.className;
			expect(darkClasses).not.toBe(lightClasses);
			harness.registry.setThemePresentation({
				colorScheme: 'light',
				rendererPalette: 'standard',
			});
			expect(editor.className).not.toBe(darkClasses);
		} finally {
			session.editor.detach(lease);
			host.remove();
		}
	});

	it('reconfigures editors only when their effective renderer theme changes', async () => {
		const harness = createHarness();
		const session = await harness.registry.open(request('src/theme-palette.ts'));
		if (!session) throw new Error('Expected a code editor session');
		await vi.waitFor(() => expect(session.loading).toBe(false));
		if (!session.editor) throw new Error('Expected a loaded code editor');
		const reconfigure = vi.spyOn(session.editor, 'reconfigure');

		harness.registry.setThemePresentation({
			colorScheme: 'light',
			rendererPalette: 'standard',
		});
		expect(reconfigure).not.toHaveBeenCalled();

		harness.registry.setThemePresentation({
			colorScheme: 'light',
			rendererPalette: 'colorblind',
		});
		harness.registry.setThemePresentation({
			colorScheme: 'light',
			rendererPalette: 'colorblind',
		});
		expect(reconfigure).toHaveBeenCalledOnce();

		harness.registry.setThemePresentation({
			colorScheme: 'dark',
			rendererPalette: 'colorblind',
		});
		expect(reconfigure).toHaveBeenCalledTimes(2);
	});

	it('settles a loading code frame before attaching its editor after the read', async () => {
		const read = deferred<{ content: string; path: string; revision: string }>();
		const runtime = deferred<FileEditorRuntimeModule>();
		const bridge = new SurfaceFrameBridge();
		const attach = vi.fn();
		const harness = createHarness({
			loadEditorRuntime: () => runtime.promise,
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
		await Promise.resolve();
		expect(opened?.loading).toBe(true);
		expect(opened?.editor).toBeNull();
		runtime.resolve(await editorRuntime());
		await vi.waitFor(() => expect(opened?.loading).toBe(false));
		bridge.provideRenderer({ attach, detach: vi.fn(), focusPrimary: vi.fn() });
		await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
		expect(opened?.content).toBe('loaded');
	});

	it('reports editor loading failures and retries with a fresh loader promise', async () => {
		const loadEditorRuntime = vi.fn(editorRuntime);
		loadEditorRuntime.mockRejectedValueOnce(new Error('Editor chunk unavailable'));
		const harness = createHarness({ loadEditorRuntime });

		const opened = await harness.registry.open(request('src/retry.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loadError).toBe('Editor chunk unavailable'));
		expect(opened.loading).toBe(false);
		expect(opened.editor).toBeNull();
		expect(opened.loadErrorRequiresPageReload).toBe(false);

		await harness.registry.reload(opened.id);

		expect(loadEditorRuntime).toHaveBeenCalledTimes(2);
		expect(opened.loadError).toBeNull();
		expect(opened.editor).toBeTruthy();
		expect(opened.content).toBe('initial');
	});

	it('retries editor initialization after switching Markdown to source', async () => {
		const loadEditorRuntime = vi.fn(editorRuntime);
		loadEditorRuntime.mockRejectedValueOnce(new Error('Editor chunk unavailable'));
		const harness = createHarness({ loadEditorRuntime });
		const opened = await harness.registry.open(request('README.md'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));

		await expect(harness.registry.showSource(opened.id)).resolves.toBe(false);
		expect(opened.loadError).toBe('Editor chunk unavailable');
		expect(opened.loadedRevision).toBe('v1:initial');

		await harness.registry.reload(opened.id);

		expect(loadEditorRuntime).toHaveBeenCalledTimes(2);
		expect(harness.readText).toHaveBeenCalledOnce();
		expect(opened.loadError).toBeNull();
		expect(opened.editor).toBeTruthy();
	});

	it('preserves source-editor initialization errors across automatic disk reloads', async () => {
		const loadEditorRuntime = vi.fn(editorRuntime);
		loadEditorRuntime.mockRejectedValueOnce(new Error('Editor chunk unavailable'));
		const harness = createHarness({ loadEditorRuntime });
		const opened = await harness.registry.open(request('README.md'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		await expect(harness.registry.showSource(opened.id)).resolves.toBe(false);
		harness.getFileRevision.mockResolvedValueOnce({ status: 'ready', revision: 'v1:external' });
		harness.readText.mockResolvedValueOnce({
			content: 'external content',
			path: '/workspace/README.md',
			revision: 'v1:external',
		});

		await harness.registry.checkFreshness(opened.id);

		expect(opened.content).toBe('external content');
		expect(opened.loadError).toBe('Editor chunk unavailable');
		expect(opened.editor).toBeNull();
		await harness.registry.reload(opened.id);
		expect(opened.loadError).toBeNull();
		expect(opened.editor).toBeTruthy();
	});

	it('reloads the page for a cached module failure after switching Markdown to source', async () => {
		const reloadApplication = vi.fn();
		const loadEditorRuntime = vi
			.fn<() => Promise<FileEditorRuntimeModule>>()
			.mockRejectedValue(new ModuleImportError(new Error('Editor chunk unavailable')));
		const harness = createHarness({ loadEditorRuntime, reloadApplication });
		const opened = await harness.registry.open(request('README.md'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));

		await expect(harness.registry.showSource(opened.id)).resolves.toBe(false);
		expect(opened.loadErrorRequiresPageReload).toBe(true);
		await harness.registry.reload(opened.id);

		expect(reloadApplication).toHaveBeenCalledOnce();
		expect(loadEditorRuntime).toHaveBeenCalledOnce();
	});

	it('reloads the page when a browser-cached editor module import fails', async () => {
		const reloadApplication = vi.fn();
		const loadEditorRuntime = vi
			.fn<() => Promise<FileEditorRuntimeModule>>()
			.mockRejectedValue(new ModuleImportError(new Error('Editor chunk unavailable')));
		const harness = createHarness({ loadEditorRuntime, reloadApplication });

		const opened = await harness.registry.open(request('src/reload-required.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loadError).toBe('Editor chunk unavailable'));
		expect(opened.loadErrorRequiresPageReload).toBe(true);

		await harness.registry.reload(opened.id);

		expect(reloadApplication).toHaveBeenCalledOnce();
		expect(loadEditorRuntime).toHaveBeenCalledOnce();
	});

	it('shares one successful editor runtime load across file sessions', async () => {
		const loadEditorRuntime = vi.fn(editorRuntime);
		const harness = createHarness({ loadEditorRuntime });

		const first = await harness.registry.open(request('src/first-runtime.ts'));
		const second = await harness.registry.open(request('src/second-runtime.ts'));
		if (!first || !second) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));

		expect(loadEditorRuntime).toHaveBeenCalledOnce();
		expect(first.editor).toBeTruthy();
		expect(second.editor).toBeTruthy();
	});

	it('does not create an editor after destruction during runtime loading', async () => {
		const runtime = deferred<FileEditorRuntimeModule>();
		const harness = createHarness({ loadEditorRuntime: () => runtime.promise });
		const opened = await harness.registry.open(request('src/disposed.ts'));
		if (!opened) throw new Error('Expected file session');

		const destruction = harness.registry.destroy(opened.id);
		runtime.resolve(await editorRuntime());
		await destruction;

		await vi.waitFor(() => expect(opened.loading).toBe(false));
		expect(opened.editor).toBeNull();
		expect(harness.registry.get(opened.id)).toBeNull();
	});

	it('coalesces presentation changes and cancels a scheduled checkpoint on close', async () => {
		const repository = createMemoryFileDraftRepository();
		const putView = vi.spyOn(repository, 'putView');
		const harness = createHarness({ draftRepository: repository });
		const opened = await harness.registry.open(request('src/presentation.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		await harness.registry.persistView(opened.id);
		vi.useFakeTimers();
		try {
			putView.mockClear();
			opened.textScrollTop = 10;
			opened.notePresentationChanged();
			await vi.advanceTimersByTimeAsync(100);
			opened.textScrollTop = 30;
			opened.notePresentationChanged();
			await vi.advanceTimersByTimeAsync(249);
			expect(putView).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(putView).toHaveBeenCalledOnce();
			expect(putView.mock.calls[0]?.[0].scrollTop).toBe(30);

			opened.notePresentationChanged();
			await harness.registry.destroy(opened.id);
			await vi.advanceTimersByTimeAsync(250);
			expect(putView).toHaveBeenCalledOnce();
			expect(await repository.getViews('test-user', 'test-deployment', 'test-session')).toEqual([]);
		} finally {
			vi.useRealTimers();
			await harness.registry.destroyAll();
		}
	});

	it('drains pending view checkpoints before deleting a closed view', async () => {
		const repository = createMemoryFileDraftRepository();
		const allowPut = deferred<void>();
		const putView = repository.putView.bind(repository);
		repository.putView = vi.fn(async (record) => {
			await allowPut.promise;
			await putView(record);
		});
		const deleteView = vi.spyOn(repository, 'deleteView');
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = await harness.registry.open(request('src/closing-view.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(repository.putView).toHaveBeenCalled());

		const destruction = harness.registry.destroy(opened.id);
		await vi.waitFor(() => expect(harness.registry.get(opened.id)).toBeNull());

		expect(deleteView).not.toHaveBeenCalled();
		allowPut.resolve();
		await destruction;
		expect(deleteView).toHaveBeenCalledOnce();
		expect(await repository.getViews('test-user', 'test-deployment', 'test-session')).toEqual([]);
	});

	it('serializes reopening behind last-view recovery cleanup', async () => {
		const repository = createMemoryFileDraftRepository();
		const allowDelete = deferred<void>();
		const deleteDraft = repository.deleteDraft.bind(repository);
		repository.deleteDraft = vi.fn(async (documentId, generation) => {
			await allowDelete.promise;
			await deleteDraft(documentId, generation);
		});
		const harness = createHarness({ draftRepository: repository });
		const opened = await harness.registry.open(request('src/reopen.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));

		const destruction = harness.registry.destroy(opened.id);
		await vi.waitFor(() => expect(harness.registry.get(opened.id)).toBeNull());
		const reopening = harness.registry.open(request('src/reopen.ts'));
		let reopenedEarly = false;
		void reopening.then(() => (reopenedEarly = true));
		await Promise.resolve();
		expect(reopenedEarly).toBe(false);

		allowDelete.resolve();
		await destruction;
		const reopened = await reopening;
		if (!reopened) throw new Error('Expected reopened file session');
		await vi.waitFor(() => expect(reopened.loading).toBe(false));
		expect(harness.registry.documents[reopened.document.id]).toBe(reopened.document);
		expect(reopened.document.editorRuntime).not.toBeNull();
		reopened.content = 'reopened edit';
		await harness.registry.flushRecovery();
		expect(await repository.getDrafts('test-user', 'test-deployment', 'test-session')).toHaveLength(
			1,
		);
	});

	it('waits for teardowns appended while reopening the same identity', async () => {
		const repository = createMemoryFileDraftRepository();
		const allowFirstDelete = deferred<void>();
		const allowSecondDelete = deferred<void>();
		const deleteView = repository.deleteView.bind(repository);
		let deleteViewCount = 0;
		repository.deleteView = vi.fn(async (viewId, userNamespace, deploymentId, browserSessionId) => {
			deleteViewCount += 1;
			await (deleteViewCount === 1 ? allowFirstDelete.promise : allowSecondDelete.promise);
			await deleteView(viewId, userNamespace, deploymentId, browserSessionId);
		});
		const harness = createHarness({ draftRepository: repository });
		const first = await harness.registry.open(request('src/chained-reopen.ts'));
		if (!first) throw new Error('Expected first file session');
		const second = await harness.registry.open({
			...request('src/chained-reopen.ts'),
			openToSide: true,
		});
		if (!second) throw new Error('Expected second file session');
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));

		const firstDestruction = harness.registry.destroy(first.id);
		await vi.waitFor(() => expect(repository.deleteView).toHaveBeenCalledTimes(1));
		const reopening = harness.registry.open(request('src/chained-reopen.ts'));
		await vi.waitFor(() => expect(harness.resolveFileIdentity).toHaveBeenCalledTimes(3));
		await Promise.resolve();
		let reopenedEarly = false;
		void reopening.then(() => (reopenedEarly = true));
		const secondDestruction = harness.registry.destroy(second.id);

		allowFirstDelete.resolve();
		await vi.waitFor(() => expect(repository.deleteView).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		expect(reopenedEarly).toBe(false);

		allowSecondDelete.resolve();
		await Promise.all([firstDestruction, secondDestruction]);
		const reopened = await reopening;
		if (!reopened) throw new Error('Expected reopened file session');
		await vi.waitFor(() => expect(reopened.loading).toBe(false));
		expect(reopened.id).not.toBe(first.id);
		expect(reopened.id).not.toBe(second.id);
		expect(harness.registry.documents[reopened.document.id]).toBe(reopened.document);
		reopened.content = 'reopened edit';
		await harness.registry.flushRecovery();
		expect(await repository.getDrafts('test-user', 'test-deployment', 'test-session')).toHaveLength(
			1,
		);
	});

	it('rechecks teardown after a same-identity side open waits in the creation queue', async () => {
		const repository = createMemoryFileDraftRepository();
		const allowPlacement = deferred<void>();
		const allowDelete = deferred<void>();
		const deleteView = repository.deleteView.bind(repository);
		repository.deleteView = vi.fn(async (viewId, userNamespace, deploymentId, browserSessionId) => {
			await allowDelete.promise;
			await deleteView(viewId, userNamespace, deploymentId, browserSessionId);
		});
		let placementCount = 0;
		const placement: FilePlacementPort = {
			async placeFileSession(_sessionId, _target, publication) {
				placementCount += 1;
				if (placementCount === 2) await allowPlacement.promise;
				publication.publish();
				return 'placed';
			},
			async focusFileSession() {},
		};
		const harness = createHarness({ draftRepository: repository, placement });
		const original = await harness.registry.open(request('src/queued-reopen.ts'));
		if (!original) throw new Error('Expected original file session');
		await vi.waitFor(() => expect(original.loading).toBe(false));

		const blocker = harness.registry.open(request('src/placement-blocker.ts'));
		await vi.waitFor(() => expect(placementCount).toBe(2));
		const reopening = harness.registry.open({
			...request('src/queued-reopen.ts'),
			openToSide: true,
		});
		await vi.waitFor(() => expect(harness.resolveFileIdentity).toHaveBeenCalledTimes(3));
		const destruction = harness.registry.destroy(original.id);
		await vi.waitFor(() => expect(repository.deleteView).toHaveBeenCalledOnce());

		allowPlacement.resolve();
		await blocker;
		await Promise.resolve();
		expect(placementCount).toBe(2);

		allowDelete.resolve();
		await destruction;
		const reopened = await reopening;
		if (!reopened) throw new Error('Expected reopened file session');
		await vi.waitFor(() => expect(reopened.loading).toBe(false));
		expect(placementCount).toBe(3);
		expect(harness.registry.documents[reopened.document.id]).toBe(reopened.document);
		expect(reopened.document).not.toBe(original.document);
		expect(reopened.document.editorRuntime).not.toBeNull();
	});

	it('focuses an existing identity without moving or duplicating it', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts', 'window-main'));
		await harness.registry.open({
			...request('src/file.ts', 'window-sidebar'),
			target: { type: 'window', windowId: 'window-sidebar' },
			line: 12,
		});

		expect(harness.registry.sessionCount).toBe(1);
		expect(harness.placementCalls).toHaveLength(1);
		expect(harness.getDefaultPlacement).toHaveBeenCalledOnce();
		expect(harness.getDefaultPlacement).toHaveBeenCalledWith('code', 'window-main');
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
		const secondOverLimitPath = `src/file-${FILE_SESSION_SOFT_LIMIT + 1}.ts`;
		const secondOverLimit = harness.registry.open(request(secondOverLimitPath));
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
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));
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

	it('guards overlapping closes when their reservations remove the final document views', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/concurrent-close.ts'));
		if (!first) throw new Error('Expected first file session');
		await vi.waitFor(() => expect(first.loading).toBe(false));
		const second = await harness.registry.open({
			...request('src/concurrent-close.ts'),
			openToSide: true,
		});
		if (!second) throw new Error('Expected second file session');
		first.content = 'local edits';

		const firstAdmission = harness.registry.prepareDestructiveViews([first.id], 'close');
		const secondAdmission = harness.registry.prepareDestructiveViews([second.id], 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(second.id));
		harness.registry.resolveGuard('cancel');

		const firstRelease = await firstAdmission;
		expect(firstRelease).toBeTypeOf('function');
		await expect(secondAdmission).resolves.toBeNull();
		firstRelease?.();
		expect(harness.registry.guardRequest).toBeNull();

		const admissionAfterRelease = await harness.registry.prepareDestructiveViews(
			[first.id],
			'close',
		);
		expect(admissionAfterRelease).toBeTypeOf('function');
		expect(harness.registry.guardRequest).toBeNull();
		admissionAfterRelease?.();
	});

	it('rejects a discard close when the buffer changes during recovery deletion', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository });
		const opened = await harness.registry.open(request('src/discard-race.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'old edit';
		const deletion = deferred<void>();
		const deleteDraft = repository.deleteDraft.bind(repository);
		vi.spyOn(repository, 'deleteDraft').mockImplementation(async (...args) => {
			await deletion.promise;
			await deleteDraft(...args);
		});

		const closing = harness.registry.prepareDestructiveViews([opened.id], 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(opened.id));
		harness.registry.resolveGuard('discard');
		await vi.waitFor(() => expect(repository.deleteDraft).toHaveBeenCalled());
		opened.content = 'new edit after discard';
		deletion.resolve();

		await expect(closing).resolves.toBeNull();
		expect(opened.content).toBe('new edit after discard');
		expect(opened.dirty).toBe(true);
	});

	it('revalidates every discarded document after all bulk-close decisions settle', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository });
		const first = await harness.registry.open(request('src/bulk-first.ts'));
		const second = await harness.registry.open(request('src/bulk-second.ts'));
		if (!first || !second) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));
		first.content = 'first edit';
		second.content = 'second edit';
		const secondDeletion = deferred<void>();
		const deleteDraft = repository.deleteDraft.bind(repository);
		let deletionCount = 0;
		vi.spyOn(repository, 'deleteDraft').mockImplementation(async (...args) => {
			deletionCount += 1;
			if (deletionCount === 2) await secondDeletion.promise;
			await deleteDraft(...args);
		});

		const closing = harness.registry.prepareDestructiveViews([first.id, second.id], 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(first.id));
		harness.registry.resolveGuard('discard');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(second.id));
		harness.registry.resolveGuard('discard');
		await vi.waitFor(() => expect(deletionCount).toBe(2));
		first.content = 'new edit during the second decision';
		secondDeletion.resolve();

		await expect(closing).resolves.toBeNull();
		expect(first.content).toBe('new edit during the second decision');
		expect(first.dirty).toBe(true);
	});

	it('releases close reservations when recovery deletion rejects', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository });
		const first = await harness.registry.open(request('src/failed-close.ts'));
		if (!first) throw new Error('Expected first file session');
		await vi.waitFor(() => expect(first.loading).toBe(false));
		const second = await harness.registry.open({
			...request('src/failed-close.ts'),
			openToSide: true,
		});
		if (!second) throw new Error('Expected second file session');
		first.content = 'first edit';
		vi.spyOn(repository, 'deleteDraft').mockRejectedValueOnce(new Error('quota'));

		const failed = harness.registry.prepareDestructiveViews([first.id, second.id], 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest).toBeTruthy());
		harness.registry.resolveGuard('discard');
		await expect(failed).rejects.toThrow('quota');
		first.content = 'second edit';

		const singleViewClose = await harness.registry.prepareDestructiveViews([first.id], 'close');
		expect(singleViewClose).toBeTypeOf('function');
		expect(harness.registry.guardRequest).toBeNull();
		singleViewClose?.();
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
		await harness.registry.destroy(first.id);
		await expect(firstDecision).resolves.toBe(false);

		const secondDecision = harness.registry.confirmDestructive(second.id, 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(second.id));
		harness.registry.resolveGuard('discard');
		await expect(secondDecision).resolves.toBe(true);
	});

	it('guards an ambiguous save failure as an unknown outcome', async () => {
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
		expect(opened.saveOutcomeUnknown).toBe(true);
		expect(opened.saveError).toContain('outcome is unknown');
	});

	it('guards an INTERNAL_ERROR Save response as an unknown outcome', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/internal-save-error.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'changed';
		harness.saveText.mockRejectedValueOnce(
			new ApiError(500, 'Internal server error', 'INTERNAL_ERROR'),
		);

		await expect(harness.registry.save(opened.id)).resolves.toBe(false);

		expect(opened.saveOutcomeUnknown).toBe(true);
		expect(opened.document.pendingSubmission?.content).toBe('changed');
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
			{ signal: expect.any(AbortSignal), timeoutMs: null },
		);
		expect(opened.baseline).toBe('newer edit');
		expect(opened.dirty).toBe(false);
	});

	it('keeps an in-flight save alive when its last view is destroyed', async () => {
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
		const destruction = harness.registry.destroy(opened.id);
		expect(signal?.aborted).toBe(false);
		pending.reject(new Error('connection lost'));

		await destruction;
		await expect(save).resolves.toBe(false);
		expect(opened.saveOutcomeUnknown).toBe(true);
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

	it('preserves history when a freshness response crosses Save acknowledgement', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/poll-save.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		if (!opened.editor) throw new Error('Expected a loaded code editor');
		const host = document.createElement('div');
		document.body.append(host);
		const lease = opened.editor.attach(host);
		const editorElement = host.querySelector<HTMLElement>('.cm-editor');
		if (!editorElement) throw new Error('Expected CodeMirror editor');
		const editor = EditorView.findFromDOM(editorElement);
		if (!editor) throw new Error('Expected CodeMirror view');
		try {
			editor.dispatch({ changes: { from: 0, insert: 'saved edit ' }, userEvent: 'input.type' });
			const saveResponse = deferred<{
				success: true;
				path: string;
				message: string;
				revision: string;
			}>();
			harness.saveText.mockReturnValueOnce(saveResponse.promise);
			const save = harness.registry.save(opened.id);
			await vi.waitFor(() => expect(harness.saveText).toHaveBeenCalledOnce());
			const freshness = deferred<FileRevisionResponse>();
			harness.getFileRevision.mockReturnValueOnce(freshness.promise);
			const check = harness.registry.checkFreshness(opened.id);
			saveResponse.resolve({
				success: true,
				path: '/workspace/src/poll-save.ts',
				message: 'saved',
				revision: 'v1:saved',
			});
			await expect(save).resolves.toBe(true);
			const runtime = opened.document.editorRuntime;
			if (!(runtime instanceof FileDocumentRuntime)) throw new Error('Expected document runtime');
			const depth = undoDepth(runtime.canonicalState);

			freshness.resolve({ status: 'ready', revision: 'v1:initial' });
			await check;

			expect(undoDepth(runtime.canonicalState)).toBe(depth);
			expect(harness.readText).toHaveBeenCalledOnce();
			expect(opened.loadedRevision).toBe('v1:saved');
		} finally {
			opened.editor.detach(lease);
			host.remove();
		}
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

		harness.readText.mockResolvedValueOnce({
			content: 'external',
			path: '/workspace/src/first.ts',
			revision: 'v1:external',
		});
		await harness.registry.checkFreshness(first.id);

		expect(first.isExternallyStale).toBe(false);
		expect(first.content).toBe('external');
		expect(first.loadedRevision).toBe('v1:external');
		expect(second.isExternallyStale).toBe(false);
		await harness.registry.checkFreshness(first.id);
		expect(harness.getFileRevision).toHaveBeenCalledTimes(2);
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

	it('preserves edits made while polling reads changed disk content', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/poll-race.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		const read = deferred<{ content: string; path: string; revision: string }>();
		harness.getFileRevision.mockResolvedValueOnce({ status: 'ready', revision: 'v1:external' });
		harness.readText.mockReturnValueOnce(read.promise);

		const check = harness.registry.checkFreshness(opened.id);
		await vi.waitFor(() => expect(harness.readText).toHaveBeenCalledTimes(2));
		opened.content = 'local while polling';
		read.resolve({
			content: 'external',
			path: '/workspace/src/poll-race.ts',
			revision: 'v1:external',
		});
		await check;

		expect(opened.content).toBe('local while polling');
		expect(opened.dirty).toBe(true);
		expect(opened.isExternallyStale).toBe(true);
		expect(opened.document.diskContent).toBe('external');
	});

	it('keeps polling a missing document and reloads it when recreated', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/recreated.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		harness.getFileRevision
			.mockResolvedValueOnce({ status: 'missing' })
			.mockResolvedValueOnce({ status: 'ready', revision: 'v1:recreated' });
		harness.readText.mockResolvedValueOnce({
			content: 'recreated',
			path: '/workspace/src/recreated.ts',
			revision: 'v1:recreated',
		});

		await harness.registry.checkFreshness(opened.id);
		expect(opened.document.missing).toBe(true);
		await harness.registry.checkFreshness(opened.id);

		expect(opened.document.missing).toBe(false);
		expect(opened.content).toBe('recreated');
		expect(opened.loadedRevision).toBe('v1:recreated');
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

	it('accepts the displayed disk snapshot from a stale Save decision', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		opened.isExternallyStale = true;
		harness.readText.mockResolvedValueOnce({
			content: 'disk',
			path: '/workspace/src/file.ts',
			revision: 'v1:disk',
		});

		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.diskRevision).toBe('v1:disk'));
		harness.registry.resolveOverwrite('accept-disk');
		await save;

		expect(opened.content).toBe('disk');
		expect(opened.loadedRevision).toBe('v1:disk');
		expect(opened.dirty).toBe(false);
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
		harness.registry.resolveOverwrite('overwrite', 'merged local');

		await expect(save).resolves.toBe(true);
		expect(harness.saveText).toHaveBeenCalledOnce();
		expect(harness.saveText).toHaveBeenCalledWith(
			{
				projectPath: '/workspace',
				filePath: 'src/file.ts',
				content: 'merged local',
				expectedRevision: 'v1:initial',
				conflictResolution: 'overwrite',
			},
			{ signal: expect.any(AbortSignal), timeoutMs: null },
		);
		expect(opened.content).toBe('merged local');
		expect(opened.dirty).toBe(false);
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
			{ signal: expect.any(AbortSignal), timeoutMs: null },
		);
		expect(opened.loadedRevision).toBe('v1:saved');
		expect(opened.isExternallyStale).toBe(false);
		expect(opened.dirty).toBe(false);
	});

	it('applies a merge to the buffer version shown after a Save conflict', async () => {
		const harness = createHarness();
		const firstSave = deferred<{
			success: true;
			path: string;
			message: string;
			revision: string;
		}>();
		harness.saveText.mockReturnValueOnce(firstSave.promise);
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'submitted local';

		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.saveText).toHaveBeenCalledOnce());
		opened.content = 'later local that will be compared';
		firstSave.reject(new ApiError(409, 'File changed on disk', 'FILE_REVISION_CONFLICT'));
		await vi.waitFor(() =>
			expect(harness.registry.overwriteRequest?.localContent).toBe(
				'later local that will be compared',
			),
		);
		harness.registry.resolveOverwrite('save-checked', 'explicit merged result');

		await expect(save).resolves.toBe(true);
		expect(opened.content).toBe('explicit merged result');
		expect(opened.baseline).toBe('explicit merged result');
		expect(opened.dirty).toBe(false);
	});

	it('executes a checked Save selected from the comparison workflow', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		harness.readText.mockResolvedValueOnce({
			content: 'disk',
			path: '/workspace/src/file.ts',
			revision: 'v1:disk',
		});

		const compare = harness.registry.showConflict(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.diskRevision).toBe('v1:disk'));
		harness.registry.resolveOverwrite('save-checked');
		await compare;

		expect(harness.saveText).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'local',
				expectedRevision: 'v1:disk',
				conflictResolution: 'reject',
			}),
			{ signal: expect.any(AbortSignal), timeoutMs: null },
		);
	});

	it('keeps mixed-line-ending comparison actions nonmutating', async () => {
		const harness = createHarness();
		harness.readText
			.mockResolvedValueOnce({
				content: 'a\r\nb\nc',
				path: '/workspace/src/mixed.ts',
				revision: 'v1:mixed',
			})
			.mockResolvedValue({
				content: 'disk',
				path: '/workspace/src/mixed.ts',
				revision: 'v1:disk',
			});
		const opened = await harness.registry.open(request('src/mixed.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		expect(opened.document.mixedLineEndings).toBe(true);

		const checked = harness.registry.showConflict(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest).toBeTruthy());
		harness.registry.resolveOverwrite('save-checked', 'normalized checked');
		await checked;

		const overwrite = harness.registry.showConflict(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest).toBeTruthy());
		harness.registry.resolveOverwrite('overwrite', 'normalized overwrite');
		await overwrite;

		expect(harness.saveText).not.toHaveBeenCalled();
		expect(opened.content).not.toContain('normalized');
	});

	it('submits against the exact disk revision displayed by the conflict dialog', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		harness.readText.mockResolvedValueOnce({
			content: 'disk-r3',
			path: '/workspace/src/file.ts',
			revision: 'v1:r3',
		});

		const compare = harness.registry.showConflict(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.diskRevision).toBe('v1:r3'));
		opened.document.diskRevision = 'v1:r4';
		opened.document.diskContent = 'disk-r4';
		harness.registry.resolveOverwrite('save-checked', 'merged');
		await compare;

		expect(harness.saveText).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'merged', expectedRevision: 'v1:r3' }),
			{ signal: expect.any(AbortSignal), timeoutMs: null },
		);
		expect(opened.content).toBe('merged');
		expect(opened.dirty).toBe(false);
	});

	it('blocks Accept Disk while a Save outcome is unknown', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';
		opened.document.saveOutcome = 'unknown';
		opened.document.pendingSubmission = {
			submissionId: 'pending',
			resourceKey: opened.identityKey,
			expectedDiskRevision: opened.loadedRevision!,
			submittedBufferVersion: opened.document.bufferVersion,
			conflictIntent: 'overwrite',
			content: 'submitted',
			startedAt: 1,
		};

		await harness.registry.showConflict(opened.id);

		expect(harness.registry.overwriteRequest).toBeNull();
		expect(opened.content).toBe('local');
	});

	it('rejects Accept Disk after the local buffer changes behind the comparison', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/accept-disk-race.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'displayed local';
		harness.readText.mockResolvedValueOnce({
			content: 'displayed disk',
			path: '/workspace/src/accept-disk-race.ts',
			revision: 'v1:disk',
		});

		const comparison = harness.registry.showConflict(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest).toBeTruthy());
		opened.content = 'newer local edit';
		harness.registry.resolveOverwrite('accept-disk');
		await comparison;

		expect(opened.content).toBe('newer local edit');
		expect(opened.dirty).toBe(true);
		expect(opened.saveError).toContain('buffer changed');
	});

	it('keeps Save ownership through a conflict retry that times out', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository, saveSoftTimeoutMs: 1 });
		const retry = deferred<{ success: true; path: string; message: string; revision: string }>();
		harness.saveText
			.mockRejectedValueOnce(new ApiError(409, 'File changed', 'FILE_REVISION_CONFLICT'))
			.mockReturnValueOnce(retry.promise);
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';

		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest).toBeTruthy());
		expect(opened.pendingMutationCount).toBe(1);
		harness.registry.resolveOverwrite('overwrite');
		await expect(save).resolves.toBe(false);
		expect(opened.saveOutcomeUnknown).toBe(true);
		expect(opened.pendingMutationCount).toBe(1);
		retry.resolve({
			success: true,
			path: '/workspace/src/file.ts',
			message: 'saved',
			revision: 'v1:late',
		});
		await vi.waitFor(() => expect(opened.saveOutcomeUnknown).toBe(false));
		expect(opened.pendingMutationCount).toBe(0);
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
		const conflict = () => new ApiError(409, 'File changed on disk', 'FILE_REVISION_CONFLICT');
		harness.saveText.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());

		const firstSave = harness.registry.save(first.id);
		const secondSave = harness.registry.save(second.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.sessionId).toBe(first.id));
		harness.registry.resolveOverwrite('cancel');
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.sessionId).toBe(second.id));
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

	it('stores image revisions without loading the editor and swaps content after refresh', async () => {
		const loadEditorRuntime = vi.fn(editorRuntime);
		const harness = createHarness({ loadEditorRuntime });
		const opened = await harness.registry.open(request('assets/logo.png'));
		if (!opened) throw new Error('Expected image session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		expect(loadEditorRuntime).not.toHaveBeenCalled();
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
		await harness.registry.destroy(opened.id);
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

	it.each([false, true])(
		'restores viewless protected drafts even when files are missing (mobile: %s)',
		async (isMobile) => {
			const repository = createMemoryFileDraftRepository();
			const dirty = storedDraft({
				documentId: 'dirty',
				normalizedRelativePath: 'missing.txt',
				content: 'irreplaceable local draft',
			});
			const unknown = storedDraft({
				documentId: 'unknown',
				normalizedRelativePath: 'pending.txt',
				content: 'initial',
				unknownSubmission: {
					submissionId: 'pending-save',
					resourceKey: 'pending.txt',
					expectedDiskRevision: 'v1:initial',
					submittedBufferVersion: 1,
					conflictIntent: 'reject',
					content: 'submitted',
					startedAt: 1,
				},
			});
			await repository.putDraft(dirty);
			await repository.putDraft(unknown);
			const host: PresentationHostId = isMobile ? 'mobile' : 'window-existing';
			const restore = vi.fn<FilePlacementPort['placeFileSession']>(
				async (_id, _target, publication) => {
					publication.publish();
					return 'placed';
				},
			);
			const place = vi.fn<FilePlacementPort['placeFileSession']>();
			const focus = vi.fn<FilePlacementPort['focusFileSession']>();
			const harness = createHarness({
				draftRepository: repository,
				isMobile,
				loadEditorRuntime: editorRuntime,
				placement: {
					placeFileSession: place,
					restoreFileSession: restore,
					focusFileSession: focus,
					recoveryHost: () => host,
					filePlacement: () => host,
				},
			});
			harness.resolveFileIdentity.mockRejectedValue(new ApiError(404, 'File not found'));
			harness.getFileRevision.mockResolvedValue({ status: 'missing' });
			try {
				await harness.registry.ready();
				expect(harness.registry.all).toHaveLength(2);
				expect(harness.resolveFileIdentity).toHaveBeenCalledTimes(2);
				expect(harness.resolveFileIdentity).toHaveBeenCalledWith({
					projectPath: '/workspace',
					relativePath: dirty.normalizedRelativePath,
				});
				expect(harness.resolveFileIdentity).toHaveBeenCalledWith({
					projectPath: '/workspace',
					relativePath: unknown.normalizedRelativePath,
				});
				for (const draft of [dirty, unknown]) {
					const restored = harness.registry.all.find(
						(session) => session.documentId === draft.documentId,
					)!;
					expect(restored.document.currentContent()).toBe(draft.content);
					expect(restored.document.missing).toBe(true);
					expect(restored.document.recoveryGuard).toBe(false);
					expect(restored.saveOutcomeUnknown).toBe(draft.unknownSubmission !== null);
					expect(restored.dirty).toBe(draft.content !== draft.baselineContent);
				}
				expect(restore.mock.calls.map(([, target]) => target)).toEqual([
					isMobile ? undefined : { type: 'window', windowId: host },
					isMobile ? undefined : { type: 'window', windowId: host },
				]);
				expect(place).not.toHaveBeenCalled();
				expect(focus).not.toHaveBeenCalled();
				expect(harness.readText).not.toHaveBeenCalled();
				expect(harness.saveText).not.toHaveBeenCalled();
				expect(
					await repository.getViews('test-user', 'test-deployment', 'test-session'),
				).toHaveLength(2);
				expect(
					await repository.getDrafts('test-user', 'test-deployment', 'test-session'),
				).toHaveLength(2);
			} finally {
				await harness.registry.destroyAll();
			}
		},
	);

	it('reuses a cancelled stored view for fallback recovery without duplicating it on restart', async () => {
		const repository = createMemoryFileDraftRepository();
		const draft = storedDraft({
			documentId: 'recovered-document',
			normalizedRelativePath: 'file.txt',
			content: 'first\nlocal draft',
		});
		const view: SpaFileViewV1 = storedView({
			viewId: 'stored-view',
			documentId: draft.documentId,
			canonicalFileRootPath: draft.canonicalFileRootPath,
			normalizedRelativePath: draft.normalizedRelativePath,
			line: 2,
			endLine: 2,
			endColumn: 6,
			scrollTop: 20,
			placement: 'dialog',
		});
		await repository.putDraft(draft);
		await repository.putView(view);
		const restore = vi.fn<FilePlacementPort['placeFileSession']>(
			async (_id, target, publication) => {
				if (target?.type === 'dialog') return 'cancelled';
				publication.publish();
				return 'placed';
			},
		);
		const placement: FilePlacementPort = {
			placeFileSession: vi.fn(),
			restoreFileSession: restore,
			focusFileSession: vi.fn(),
			recoveryHost: () => 'window-main',
			filePlacement: () => 'window-main',
		};
		for (let startup = 0; startup < 2; startup += 1) {
			const harness = createHarness({
				draftRepository: repository,
				loadEditorRuntime: editorRuntime,
				placement,
			});
			try {
				await harness.registry.ready();
				expect(harness.registry.all.map((session) => session.id)).toEqual([view.viewId]);
				const restored = harness.registry.get(view.viewId)!;
				expect(restored.document.currentContent()).toBe(draft.content);
				expect(restored.document.recoveryGuard).toBe(false);
				expect(restored.editor?.selectionLocation()).toEqual({
					line: 2,
					column: 1,
					endLine: 2,
					endColumn: 6,
				});
				const records = await repository.getViews('test-user', 'test-deployment', 'test-session');
				expect(records).toHaveLength(1);
				expect(records[0]).toMatchObject({ viewId: view.viewId, placement: 'window-main' });
			} finally {
				await harness.registry.destroyAll();
			}
		}
		expect(restore.mock.calls.map(([id, target]) => [id, target])).toEqual([
			[view.viewId, { type: 'dialog' }],
			[view.viewId, { type: 'window', windowId: 'window-main' }],
			[view.viewId, { type: 'window', windowId: 'window-main' }],
		]);
	});

	it.each(['cancelled', 'thrown'] as const)(
		'continues recovering and reconciling drafts after a %s fallback placement',
		async (failure) => {
			const repository = createMemoryFileDraftRepository();
			for (const documentId of ['first', 'second']) {
				await repository.putDraft(
					storedDraft({
						documentId,
						normalizedRelativePath: `${documentId}.txt`,
						content: `${documentId} local draft`,
					}),
				);
			}
			const restore = vi.fn<FilePlacementPort['placeFileSession']>(
				async (_id, _target, publication) => {
					if (restore.mock.calls.length === 1) {
						if (failure === 'thrown') throw new Error('File surface was not placed');
						return 'cancelled';
					}
					publication.publish();
					return 'placed';
				},
			);
			const harness = createHarness({
				draftRepository: repository,
				loadEditorRuntime: editorRuntime,
				placement: {
					placeFileSession: vi.fn(),
					restoreFileSession: restore,
					focusFileSession: vi.fn(),
					filePlacement: () => 'window-main',
				},
			});
			harness.getFileRevision.mockResolvedValue({ status: 'missing' });
			try {
				await harness.registry.ready();
				expect(restore).toHaveBeenCalledTimes(2);
				expect(harness.registry.all.map((session) => session.documentId)).toEqual(['second']);
				expect(harness.registry.all[0]?.content).toBe('second local draft');
				expect(harness.registry.all[0]?.document.missing).toBe(true);
				for (const document of Object.values(harness.registry.documents)) {
					expect(document.recoveryGuard).toBe(true);
					expect(document.recoveryDiscoveryError).toBe('Could not open every recovered file draft');
				}
				expect(harness.getFileRevision).toHaveBeenCalledOnce();
				expect(
					await repository.getDrafts('test-user', 'test-deployment', 'test-session'),
				).toHaveLength(2);
				const retained = harness.registry.all[0]!;
				const editor = retained.editor!;
				editor.restorePresentation({ line: 1, column: 3, endLine: 1, endColumn: 6 }, []);
				retained.textScrollTop = 47;
				await harness.registry.retryRecoveryDiscovery();
				expect(harness.registry.get(retained.id)).toBe(retained);
				expect(retained.editor).toBe(editor);
				expect(retained.textScrollTop).toBe(47);
				expect(editor.selectionLocation()).toEqual({
					line: 1,
					column: 3,
					endLine: 1,
					endColumn: 6,
				});
				expect(restore).toHaveBeenCalledTimes(3);
				expect(harness.registry.all.map((session) => session.documentId).sort()).toEqual([
					'first',
					'second',
				]);
				expect(
					Object.values(harness.registry.documents).every((document) => !document.recoveryGuard),
				).toBe(true);
			} finally {
				await harness.registry.destroyAll();
			}
		},
	);

	it('does not guard recovery after a fallback draft is discarded and closed during editor loading', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(
			storedDraft({
				documentId: 'discarded',
				normalizedRelativePath: 'file.txt',
				content: 'local draft',
			}),
		);
		const runtime = deferred<FileEditorRuntimeModule>();
		const harness = createHarness({
			draftRepository: repository,
			loadEditorRuntime: () => runtime.promise,
		});
		try {
			await vi.waitFor(() =>
				expect(harness.registry.all[0]?.pendingSourcePresentation).toBeTruthy(),
			);
			const restored = harness.registry.all[0]!;
			restored.document.applyUserEdit(restored.baseline);
			await harness.registry.destroy(restored.id);
			runtime.resolve(testEditorRuntime);
			await harness.registry.ready();
			expect(harness.registry.all).toEqual([]);
			expect(await repository.getDrafts('test-user', 'test-deployment', 'test-session')).toEqual(
				[],
			);
			expect(await repository.getViews('test-user', 'test-deployment', 'test-session')).toEqual([]);
			const opened = await harness.registry.open(request('other.txt'));
			expect(opened?.document.recoveryGuard).toBe(false);
			expect(opened?.document.recoveryDiscoveryError).toBeNull();
		} finally {
			runtime.resolve(testEditorRuntime);
			await harness.registry.destroyAll();
		}
	});

	it('guards Retry after an identity probe fails for a restored dirty draft', async () => {
		const repository = createMemoryFileDraftRepository();
		const putRecent = vi.spyOn(repository, 'putRecent');
		const putNavigation = vi.spyOn(repository, 'putNavigation');
		const draft = storedDraft({
			documentId: 'restored-document',
			normalizedRelativePath: 'src/restored.ts',
			content: 'alpha\nbeta\ngamma',
			bufferVersion: 7,
		});
		const view: SpaFileViewV1 = storedView({
			viewId: 'restored-view',
			documentId: draft.documentId,
			canonicalFileRootPath: draft.canonicalFileRootPath,
			normalizedRelativePath: draft.normalizedRelativePath,
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
			scrollLeft: 4,
			scrollTop: 8,
			markdownScrollLeft: 12,
			markdownScrollTop: 173,
			imageMode: 'manual',
			imageScale: 1.75,
			imageScrollLeft: 32,
			imageScrollTop: 48,
		});
		await repository.putDraft(draft);
		await repository.putView(view);
		const harness = createHarness({ draftRepository: repository });
		harness.resolveFileIdentity.mockRejectedValueOnce(new Error('Identity unavailable'));

		await harness.registry.ready();
		const restored = harness.registry.get(view.viewId);

		expect(harness.registry.all).toHaveLength(1);
		expect(restored?.document.id).toBe(draft.documentId);
		expect(restored?.content).toBe('alpha\nbeta\ngamma');
		expect(restored?.dirty).toBe(true);
		expect(restored?.textScrollTop).toBe(8);
		expect(restored?.markdownScrollLeft).toBe(12);
		expect(restored?.markdownScrollTop).toBe(173);
		expect(restored?.image).toEqual({
			mode: 'manual',
			scale: 1.75,
			scrollLeft: 32,
			scrollTop: 48,
		});
		expect(restored?.editorState?.selection.main.from).toBe(7);
		expect(restored?.editorState?.selection.main.to).toBe(9);
		expect(restored?.loadError).toBe('Identity unavailable');
		expect(harness.readText).not.toHaveBeenCalled();
		expect(putRecent).not.toHaveBeenCalled();
		expect(putNavigation).not.toHaveBeenCalled();
		if (!restored) throw new Error('Expected restored file');
		const retry = harness.registry.reload(restored.id);
		await vi.waitFor(() => expect(harness.registry.guardRequest?.reason).toBe('refresh'));
		harness.registry.resolveGuard('cancel');
		await retry;
		expect(restored.content).toBe(draft.content);
		expect(harness.readText).not.toHaveBeenCalled();
	});

	it('restores CRLF metadata for a Markdown draft without initializing an editor', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(
			storedDraft({
				documentId: 'markdown-document',
				normalizedRelativePath: 'README.md',
				baselineContent: 'first\r\nsecond',
				content: 'first\r\nsecond local',
				bufferVersion: 2,
				closed: true,
			}),
		);
		const harness = createHarness({ draftRepository: repository });

		await harness.registry.ready();
		const [restored] = Object.values(harness.registry.documents);

		expect(restored?.contentKind).toBe('markdown');
		expect(restored?.lineSeparator).toBe('\r\n');
		expect(restored?.mixedLineEndings).toBe(false);
		expect(restored?.editorRuntime).toBeNull();
	});

	it('retains restored source presentation until a Markdown preview enters edit mode', async () => {
		const repository = createMemoryFileDraftRepository();
		const content = '# Heading\nbody\n\n## Next\nmore';
		const view: SpaFileViewV1 = storedView({
			viewId: 'markdown-preview-view',
			documentId: 'markdown-preview-document',
			normalizedRelativePath: 'README.md',
			rendererMode: 'markdown',
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
			scrollLeft: 6,
			scrollTop: 30,
			folds: [{ from: 15, to: content.length }],
		});
		await repository.putView(view);
		const harness = createHarness({ draftRepository: repository, userNamespace: null });
		const loaded = deferred<{
			content: string;
			path: string;
			revision: string;
		}>();
		harness.readText.mockReturnValueOnce(loaded.promise);

		const recovery = harness.registry.initializeRecovery('test-user', 'test-session');
		await vi.waitFor(() => expect(harness.registry.get(view.viewId)).not.toBeNull());
		const inFlight = harness.registry.get(view.viewId);
		expect(inFlight?.onPresentationChanged).toBeNull();
		loaded.resolve({
			content,
			path: '/workspace/README.md',
			revision: 'v1:markdown',
		});
		await recovery;
		const restored = harness.registry.get(view.viewId);
		if (!restored) throw new Error('Expected restored Markdown preview');
		expect(restored.onPresentationChanged).not.toBeNull();
		expect(restored.rendererMode).toBe('markdown');
		expect(restored.editor).toBeNull();
		expect(restored.pendingSourcePresentation).toEqual({
			selection: { line: 2, column: 2, endLine: 2, endColumn: 4 },
			folds: view.folds,
		});
		const [persistedPreview] = await repository.getViews(
			'test-user',
			'test-deployment',
			'test-session',
		);
		expect(persistedPreview).toMatchObject({
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
			folds: view.folds,
		});

		await expect(harness.registry.showSource(restored.id)).resolves.toBe(true);

		expect(restored.editor?.selectionLocation()).toEqual({
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
		});
		expect(restored.editor?.folds()).toEqual(view.folds);
	});

	it('does not persist incomplete presentation while a view is restoring', async () => {
		const repository = createMemoryFileDraftRepository();
		const view: SpaFileViewV1 = storedView({
			viewId: 'restoring-layout-view',
			documentId: 'restoring-layout-document',
			normalizedRelativePath: 'README.md',
			rendererMode: 'markdown',
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
			scrollLeft: 6,
			scrollTop: 30,
			folds: [{ from: 15, to: 26 }],
		});
		await repository.putView(view);
		let checkpoint: SpaFileViewV1[] = [];
		const harness = createHarness({
			draftRepository: repository,
			userNamespace: null,
			onPublish: async (registry) => {
				for (const session of registry.all) await registry.persistView(session.id);
				checkpoint = await repository.getViews('test-user', 'test-deployment', 'test-session');
			},
		});
		harness.readText.mockResolvedValue({
			content: '# Heading\nbody\n\n## Next\nmore',
			path: '/workspace/README.md',
			revision: 'v1:markdown',
		});

		await harness.registry.initializeRecovery('test-user', 'test-session');

		expect(checkpoint[0]).toMatchObject({
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
			scrollLeft: 6,
			scrollTop: 30,
			folds: view.folds,
		});
	});

	it('waits for a restored document read before applying its saved presentation', async () => {
		const repository = createMemoryFileDraftRepository();
		const view = storedView({
			viewId: 'loading-restored-view',
			documentId: 'loading-restored-document',
			normalizedRelativePath: 'src/restored.ts',
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
		});
		await repository.putView(view);
		const read = deferred<{ content: string; path: string; revision: string }>();
		const harness = createHarness({ draftRepository: repository, userNamespace: null });
		harness.readText.mockReturnValueOnce(read.promise);
		let completed = false;
		const recovery = harness.registry.initializeRecovery('test-user', 'test-session').then(() => {
			completed = true;
		});
		await vi.waitFor(() => expect(harness.readText).toHaveBeenCalledOnce());
		const restored = harness.registry.get(view.viewId)!;
		expect(restored.loading).toBe(true);
		expect(restored.pendingSourcePresentation).toBeNull();
		expect(completed).toBe(false);

		read.resolve({
			content: 'alpha\nbeta\ngamma',
			path: '/workspace/src/restored.ts',
			revision: 'v1:restored',
		});
		await recovery;

		expect(restored.loading).toBe(false);
		expect(restored.editor?.selectionLocation()).toEqual({
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
		});
		expect(completed).toBe(true);
	});

	it('does not recreate a closed view after delayed restoration completes', async () => {
		const repository = createMemoryFileDraftRepository();
		const view: SpaFileViewV1 = storedView({
			viewId: 'delayed-restoration-view',
			documentId: 'delayed-restoration-document',
			normalizedRelativePath: 'src/restored.ts',
		});
		await repository.putView(view);
		const runtime = deferred<FileEditorRuntimeModule>();
		const harness = createHarness({
			draftRepository: repository,
			userNamespace: null,
			loadEditorRuntime: () => runtime.promise,
		});

		const recovery = harness.registry.initializeRecovery('test-user', 'test-session');
		await vi.waitFor(() => expect(harness.registry.get(view.viewId)).not.toBeNull());
		await harness.registry.destroy(view.viewId);
		runtime.resolve(testEditorRuntime);
		await recovery;

		expect(await repository.getViews('test-user', 'test-deployment', 'test-session')).toEqual([]);
	});

	it('does not recreate a closed Markdown view after delayed source initialization', async () => {
		const repository = createMemoryFileDraftRepository();
		const runtime = deferred<FileEditorRuntimeModule>();
		const harness = createHarness({
			draftRepository: repository,
			loadEditorRuntime: () => runtime.promise,
		});
		const opened = await harness.registry.open(request('README.md'));
		if (!opened) throw new Error('Expected Markdown view');
		await vi.waitFor(() => expect(opened.loading).toBe(false));

		const showing = harness.registry.showSource(opened.id);
		await harness.registry.destroy(opened.id);
		runtime.resolve(testEditorRuntime);
		await showing;

		expect(await repository.getViews('test-user', 'test-deployment', 'test-session')).toEqual([]);
	});

	it('constructs one editor when restoration and document joining initialize concurrently', async () => {
		const repository = createMemoryFileDraftRepository();
		const view: SpaFileViewV1 = storedView({
			viewId: 'concurrent-editor-view',
			documentId: 'concurrent-editor-document',
			normalizedRelativePath: 'src/restored.ts',
			folds: [{ from: 0, to: 3 }],
		});
		await repository.putView(view);
		await repository.putDraft(
			storedDraft({
				documentId: view.documentId,
				normalizedRelativePath: view.normalizedRelativePath,
				content: 'abc\ndef',
				baselineContent: 'abc\ndef',
			}),
		);
		const runtime = deferred<FileEditorRuntimeModule>();
		const harness = createHarness({
			draftRepository: repository,
			userNamespace: null,
			loadEditorRuntime: () => runtime.promise,
		});
		const recovery = harness.registry.initializeRecovery('test-user', 'test-session');
		await vi.waitFor(() =>
			expect(harness.registry.get(view.viewId)?.pendingSourcePresentation).toBeTruthy(),
		);
		let constructors = 0;
		runtime.resolve({
			CodeEditorController: class extends testEditorRuntime.CodeEditorController {
				constructor(...args: ConstructorParameters<typeof testEditorRuntime.CodeEditorController>) {
					super(...args);
					constructors += 1;
				}
			},
		});

		await recovery;

		const restored = harness.registry.get(view.viewId);
		expect(constructors).toBe(1);
		expect(restored?.editor?.folds()).toEqual(view.folds);
	});

	it('maps deferred Markdown source presentation through shared document edits', async () => {
		const repository = createMemoryFileDraftRepository();
		const content = '# Heading\nbody\n\n## Next\nmore';
		const view: SpaFileViewV1 = storedView({
			viewId: 'mapped-preview-view',
			documentId: 'mapped-preview-document',
			normalizedRelativePath: 'README.md',
			rendererMode: 'markdown',
			line: 2,
			column: 2,
			endLine: 2,
			endColumn: 4,
			folds: [{ from: 15, to: 26 }],
		});
		await repository.putView(view);
		const harness = createHarness({ draftRepository: repository, userNamespace: null });
		harness.readText.mockResolvedValue({
			content,
			path: '/workspace/README.md',
			revision: 'v1:markdown',
		});
		await harness.registry.initializeRecovery('test-user', 'test-session');
		const preview = harness.registry.get(view.viewId);
		if (!preview) throw new Error('Expected restored preview');
		const source = await harness.registry.open({
			...request('README.md'),
			mode: 'code',
			openToSide: true,
		});
		if (!source) throw new Error('Expected source view');
		await vi.waitFor(() => expect(source.editor).not.toBeNull());
		source.editor?.restorePresentation(view, view.folds);

		source.document.applyUserEdit(`inserted\n${content}`);
		const expected = {
			selection: source.editor?.selectionLocation(),
			folds: source.editor?.folds(),
		};
		await harness.registry.showSource(preview.id);

		expect({
			selection: preview.editor?.selectionLocation(),
			folds: preview.editor?.folds(),
		}).toEqual(expected);
	});

	it('persists Markdown and image presentation state with a file view', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository });
		const opened = await harness.registry.open(request('src/presentation.md'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.markdownScrollLeft = 14;
		opened.markdownScrollTop = 91;
		opened.image = { mode: 'manual', scale: 2, scrollLeft: 27, scrollTop: 63 };

		await harness.registry.persistView(opened.id);

		const [stored] = await repository.getViews('test-user', 'test-deployment', 'test-session');
		expect(stored).toMatchObject({
			markdownScrollLeft: 14,
			markdownScrollTop: 91,
			imageMode: 'manual',
			imageScale: 2,
			imageScrollLeft: 27,
			imageScrollTop: 63,
		});
	});

	it('restores a missing clean file as an actionable placeholder', async () => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
		const repository = createMemoryFileDraftRepository();
		const view: SpaFileViewV1 = storedView({
			viewId: 'missing-view',
			documentId: 'missing-document',
			normalizedRelativePath: 'missing.ts',
		});
		await repository.putView(view);
		let visible = false;
		const harness = createHarness({
			draftRepository: repository,
			isDocumentVisible: () => visible,
		});
		harness.getFileRevision.mockResolvedValue({ status: 'missing' });
		harness.resolveFileIdentity.mockRejectedValueOnce(
			new ApiError(404, 'File not found', 'FILE_NOT_FOUND'),
		);

		await harness.registry.ready();
		const restored = harness.registry.get(view.viewId);

		expect(restored?.document.missing).toBe(true);
		expect(restored?.loadError).toBe('File not found');
		if (!restored) throw new Error('Expected restored missing file');
		harness.readText.mockResolvedValueOnce({
			content: 'recreated',
			path: '/workspace/missing.ts',
			revision: 'v1:recreated',
		});
		await harness.registry.reload(restored.id);
		expect(restored.loadedRevision).toBe('v1:recreated');
		harness.getFileRevision.mockResolvedValue({ status: 'ready', revision: 'v1:recreated' });
		harness.getFileRevision.mockClear();
		visible = true;
		harness.registry.viewVisibilityChanged(view.viewId);
		await vi.waitFor(() => expect(harness.getFileRevision).toHaveBeenCalledOnce());
	});

	it('retries a restored missing image through the binary reader', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putView(
			storedView({
				viewId: 'missing-image-view',
				documentId: 'missing-image-document',
				normalizedRelativePath: 'missing.png',
				rendererMode: 'image',
			}),
		);
		const harness = createHarness({ draftRepository: repository });
		harness.resolveFileIdentity.mockRejectedValueOnce(
			new ApiError(404, 'File not found', 'FILE_NOT_FOUND'),
		);
		await harness.registry.ready();
		const restored = harness.registry.get('missing-image-view');
		if (!restored) throw new Error('Expected restored image placeholder');

		await harness.registry.reload(restored.id);

		expect(restored.contentKind).toBe('image');
		expect(harness.readContent).toHaveBeenCalledTimes(1);
		expect(harness.readText).not.toHaveBeenCalled();
	});

	it.each(['placed', 'cancelled', 'thrown'] as const)(
		'groups remapped views after %s restoration',
		async (result) => {
			const repository = createMemoryFileDraftRepository();
			await repository.putView(
				storedView({
					viewId: 'restored-a',
					documentId: 'restored-a-document',
					normalizedRelativePath: 'src/a.ts',
					placement: 'window-file-only',
				}),
			);
			await repository.putView(
				storedView({
					viewId: 'restored-b',
					documentId: 'restored-b-document',
					normalizedRelativePath: 'src/b.ts',
					placement: 'window-file-only',
					updatedAt: 2,
				}),
			);
			await repository.putDraft(
				storedDraft({
					documentId: 'restored-b-document',
					normalizedRelativePath: 'src/b.ts',
					content: 'protected draft',
				}),
			);
			let refuseSecondView = result !== 'placed';
			const targets: Array<DesktopPlacement | undefined> = [];
			const placements = new Map<string, PresentationHostId>();
			const placement: FilePlacementPort = {
				async placeFileSession(sessionId, target, publication) {
					targets.push(target);
					if (sessionId === 'restored-b' && refuseSecondView) {
						if (result === 'thrown') throw new Error('Placement failed');
						return 'cancelled';
					}
					publication.publish();
					let host: PresentationHostId = 'dialog';
					if (target?.type === 'new-window') host = 'window-restored';
					else if (target?.type === 'window') host = target.windowId;
					placements.set(sessionId, host);
					return 'placed';
				},
				async focusFileSession() {},
				filePlacement: (sessionId) => placements.get(sessionId) ?? null,
				resolveRestoredPlacement: (host) => {
					if (host === 'window-file-only') {
						return { type: 'new-window', anchorWindowId: 'window-main' };
					}
					if (host === 'mobile' || host === 'dialog') return undefined;
					return { type: 'window', windowId: host };
				},
			};
			const harness = createHarness({ draftRepository: repository, placement });

			await harness.registry.ready();

			expect(targets.slice(0, 2)).toEqual([
				{ type: 'new-window', anchorWindowId: 'window-main' },
				{ type: 'window', windowId: 'window-restored' },
			]);
			const first = harness.registry.get('restored-a');
			expect(first).not.toBeNull();
			const records = await repository.getViews('test-user', 'test-deployment', 'test-session');
			expect(records.find((record) => record.viewId === 'restored-a')?.placement).toBe(
				'window-restored',
			);
			if (refuseSecondView) {
				expect(harness.registry.get('restored-b')).toBeNull();
				expect(records.find((record) => record.viewId === 'restored-b')?.placement).toBe(
					'window-file-only',
				);
				refuseSecondView = false;
				await harness.registry.retryRecoveryDiscovery();
				expect(harness.registry.get('restored-a')).toBe(first);
				expect(targets.at(-1)).toEqual({ type: 'window', windowId: 'window-restored' });
			}
			expect(targets.filter((target) => target?.type === 'new-window')).toHaveLength(1);
			expect(placements.get('restored-b')).toBe('window-restored');
			expect(harness.registry.get('restored-b')?.document.recoveryGuard).toBe(false);
		},
	);

	it('removes retained file surfaces that are not owned by recovered view records', async () => {
		const removeUnclaimedRestoredFileSurfaces = vi.fn(async () => undefined);
		const harness = createHarness({
			placement: {
				async placeFileSession(_sessionId, _target, publication) {
					publication.publish();
					return 'placed';
				},
				async focusFileSession() {},
				removeUnclaimedRestoredFileSurfaces,
			},
		});

		await harness.registry.ready();

		expect(removeUnclaimedRestoredFileSurfaces).toHaveBeenCalledWith([]);
	});

	it('waits for an authenticated recovery namespace before loading records', async () => {
		const repository = createMemoryFileDraftRepository();
		const record = storedDraft({
			documentId: 'authenticated-document',
			normalizedRelativePath: 'auth.ts',
			diskRevision: null,
			baselineContent: '',
			content: 'private draft',
			closed: true,
		});
		await repository.putDraft(record);
		const harness = createHarness({ draftRepository: repository, userNamespace: null });

		expect(harness.registry.documents[record.documentId]).toBeUndefined();
		await harness.registry.initializeRecovery('test-user', 'test-session');

		expect(harness.registry.documents[record.documentId]?.content).toBe('private draft');
	});

	it.each(['keep-current', 'use-recovered'] as const)(
		'resolves divergent live and recovered copies with %s',
		async (choice) => {
			const repository = createMemoryFileDraftRepository();
			const harness = createHarness({ draftRepository: repository, userNamespace: null });
			const opened = await harness.registry.open(request('src/file.ts'));
			if (!opened) throw new Error('Expected file session');
			await vi.waitFor(() => expect(opened.loading).toBe(false));
			opened.content = 'newer live edit';
			const unrelated = await harness.registry.open(request('unrelated.ts'));
			if (!unrelated) throw new Error('Expected unrelated file');
			await repository.putDraft(
				storedDraft({
					documentId: 'older-stored-draft',
					normalizedRelativePath: 'src/file.ts',
					content: 'older unsaved edit',
				}),
			);

			await harness.registry.initializeRecovery('test-user', 'test-session');

			expect(opened.content).toBe('newer live edit');
			expect(opened.document.recoveryGuard).toBe(false);
			expect(opened.document.recoveryDiscoveryError).toBeNull();
			expect(opened.document.recoveredCopies).toMatchObject([
				{ id: 'older-stored-draft', content: 'older unsaved edit' },
			]);
			expect(unrelated.document.mutationGuarded).toBe(false);
			await expect(harness.registry.save(opened.id)).resolves.toBe(false);
			await expect(harness.registry.confirmDestructive(opened.id, 'close')).resolves.toBe(false);
			expect(
				(await repository.getDrafts('test-user', 'test-deployment', 'test-session'))
					.map((draft) => draft.content)
					.sort(),
			).toEqual(['newer live edit', 'older unsaved edit']);
			await harness.registry.retryRecoveryDiscovery();
			expect(opened.document.recoveredCopies).toHaveLength(1);
			expect(opened.document.recoveryGuard).toBe(false);
			await expect(
				harness.registry.resolveRecoveredCopy(opened.id, 'older-stored-draft', choice),
			).resolves.toBe(true);
			expect(opened.content).toBe(
				choice === 'keep-current' ? 'newer live edit' : 'older unsaved edit',
			);
			expect(opened.document.recoveredCopies).toEqual([]);
			expect(opened.document.mutationGuarded).toBe(false);
			const records = await repository.getDrafts('test-user', 'test-deployment', 'test-session');
			expect(records).toHaveLength(1);
			expect(records[0]?.content).toBe(opened.content);
			await expect(harness.registry.save(opened.id)).resolves.toBe(true);
			await harness.registry.destroyAll();
		},
	);

	it.each(['same', 'different'])(
		'restores %s-content drafts for one identity without a global lock',
		async (variant) => {
			const repository = createMemoryFileDraftRepository();
			await repository.putDraft(
				storedDraft({
					documentId: 'first',
					normalizedRelativePath: 'copies.ts',
					content: 'first edit',
				}),
			);
			await repository.putDraft(
				storedDraft({
					documentId: 'second',
					normalizedRelativePath: 'copies.ts',
					content: variant === 'same' ? 'first edit' : 'second edit',
				}),
			);
			const harness = createHarness({ draftRepository: repository });
			await harness.registry.ready();
			expect(Object.keys(harness.registry.documents)).toHaveLength(1);
			const opened = harness.registry.all[0]!;
			expect(opened.document.recoveryGuard).toBe(false);
			expect(opened.document.recoveredCopies).toHaveLength(1);
			await harness.registry.retryRecoveryDiscovery();
			expect(opened.document.recoveredCopies).toHaveLength(1);
			await harness.registry.destroyAll();
		},
	);

	it.each(['keep-current', 'use-recovered'] as const)(
		'retains an alternate unknown submission after %s',
		async (choice) => {
			const repository = createMemoryFileDraftRepository();
			const harness = createHarness({ draftRepository: repository, userNamespace: null });
			const opened = await harness.registry.open(request('unknown-copy.ts'));
			if (!opened) throw new Error('Expected live file');
			await vi.waitFor(() => expect(opened.loading).toBe(false));
			opened.content = 'current edit';
			const source = storedDraft({
				documentId: 'unknown-copy',
				normalizedRelativePath: 'unknown-copy.ts',
				content: 'recovered edit',
				baselineContent: 'recovered base',
				diskRevision: 'v1:recovered',
				unknownSubmission: {
					submissionId: 'unfinished',
					resourceKey: opened.document.identityKey,
					expectedDiskRevision: 'v1:recovered',
					submittedBufferVersion: 1,
					conflictIntent: 'overwrite',
					content: 'submitted snapshot',
					startedAt: 1,
				},
			});
			await repository.putDraft(source);
			await harness.registry.initializeRecovery('test-user', 'test-session');
			await expect(
				harness.registry.resolveRecoveredCopy(opened.id, source.documentId, choice),
			).resolves.toBe(true);
			expect(opened.document.pendingSubmission).toEqual(source.unknownSubmission);
			expect(opened.saveOutcomeUnknown).toBe(true);
			expect(opened.baseline).toBe(choice === 'use-recovered' ? 'recovered base' : 'initial');
			expect(opened.loadedRevision).toBe(
				choice === 'use-recovered' ? 'v1:recovered' : 'v1:initial',
			);
			await expect(harness.registry.save(opened.id)).resolves.toBe(false);
			const records = await repository.getDrafts('test-user', 'test-deployment', 'test-session');
			expect(records).toHaveLength(1);
			expect(records[0]?.unknownSubmission).toEqual(source.unknownSubmission);
			await harness.registry.destroyAll();
		},
	);

	it('retains both copies after failed resolution and retries without mutating the live buffer early', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(
			storedDraft({
				documentId: 'first',
				normalizedRelativePath: 'copies.ts',
				content: 'first edit',
			}),
		);
		await repository.putDraft(
			storedDraft({
				documentId: 'second',
				normalizedRelativePath: 'copies.ts',
				content: 'second edit',
			}),
		);
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = harness.registry.all[0]!;
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const resolve = vi
			.spyOn(repository, 'resolveDraftConflict')
			.mockRejectedValueOnce(new Error('storage unavailable'));
		try {
			await expect(
				harness.registry.resolveRecoveredCopy(opened.id, 'second', 'use-recovered'),
			).resolves.toBe(false);
			expect(opened.content).toBe('first edit');
			expect(opened.document.recoveryResolutionError).toBeTruthy();
			expect(opened.document.recoveredCopies).toHaveLength(1);
			expect(
				await repository.getDrafts('test-user', 'test-deployment', 'test-session'),
			).toHaveLength(2);
			await expect(
				harness.registry.resolveRecoveredCopy(opened.id, 'second', 'use-recovered'),
			).resolves.toBe(true);
			expect(opened.content).toBe('second edit');
			expect(resolve).toHaveBeenCalledTimes(2);
		} finally {
			report.mockRestore();
			await harness.registry.destroyAll();
		}
	});

	it('serializes lifecycle checkpoints with an in-flight recovery choice', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(
			storedDraft({
				documentId: 'first',
				normalizedRelativePath: 'copies.ts',
				content: 'first edit',
			}),
		);
		await repository.putDraft(
			storedDraft({
				documentId: 'second',
				normalizedRelativePath: 'copies.ts',
				content: 'second edit',
			}),
		);
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = harness.registry.all[0]!;
		const commit = repository.resolveDraftConflict.bind(repository);
		const started = deferred<void>();
		const release = deferred<void>();
		vi.spyOn(repository, 'resolveDraftConflict').mockImplementation(async (...args) => {
			started.resolve();
			await release.promise;
			await commit(...args);
		});
		const choice = harness.registry.resolveRecoveredCopy(opened.id, 'second', 'use-recovered');
		await started.promise;
		expect(opened.content).toBe('first edit');
		const checkpoint = harness.registry.flushRecovery();
		release.resolve();
		await expect(choice).resolves.toBe(true);
		await checkpoint;
		const records = await repository.getDrafts('test-user', 'test-deployment', 'test-session');
		expect(records).toHaveLength(1);
		expect(records[0]?.content).toBe('second edit');
		await harness.registry.destroyAll();
	});

	it('does not discard either of two distinct unfinished submissions when choosing a copy', async () => {
		const repository = createMemoryFileDraftRepository();
		for (const id of ['first', 'second']) {
			await repository.putDraft(
				storedDraft({
					documentId: id,
					normalizedRelativePath: 'copies.ts',
					content: `${id} edit`,
					unknownSubmission: {
						submissionId: id,
						resourceKey: JSON.stringify(['/workspace', 'copies.ts']),
						expectedDiskRevision: 'v1:initial',
						submittedBufferVersion: 1,
						conflictIntent: 'overwrite',
						content: `${id} submitted`,
						startedAt: 1,
					},
				}),
			);
		}
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = harness.registry.all[0]!;
		await expect(
			harness.registry.resolveRecoveredCopy(opened.id, 'second', 'use-recovered'),
		).resolves.toBe(false);
		expect(opened.document.recoveryResolutionError).toContain('different unfinished Saves');
		expect(opened.document.recoveredCopies).toHaveLength(1);
		expect(await repository.getDrafts('test-user', 'test-deployment', 'test-session')).toHaveLength(
			2,
		);
		await harness.registry.destroyAll();
	});

	it('guards canonical mutations when scoped recovery discovery fails', async () => {
		const repository = createMemoryFileDraftRepository();
		vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('storage unavailable'));
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';

		expect(opened.document.recoveryGuard).toBe(true);
		expect(opened.document.recoveryDiscoveryError).toBe('storage unavailable');
		await expect(harness.registry.save(opened.id)).resolves.toBe(false);

		await harness.registry.retryRecoveryDiscovery();
		expect(opened.document.recoveryGuard).toBe(false);
		expect(opened.document.recoveryDiscoveryError).toBeNull();
	});

	it('adopts a recovered draft into an already-open document before unlocking recovery', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft({
			schemaVersion: 1,
			deploymentId: 'test-deployment',
			userNamespace: 'test-user',
			browserSessionId: 'test-session',
			documentId: 'restored-document',
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: 'src/file.ts',
			displayPath: 'src/file.ts',
			diskRevision: 'v1:restored',
			baselineContent: 'restored base',
			content: 'recovered edit',
			bufferVersion: 5,
			savedAt: 1,
			generation: 5,
			unknownSubmission: {
				submissionId: 'unknown-save',
				resourceKey: JSON.stringify(['/workspace', 'src/file.ts']),
				expectedDiskRevision: 'v1:restored',
				submittedBufferVersion: 4,
				conflictIntent: 'overwrite',
				content: 'submitted edit',
				startedAt: 1,
			},
			closed: false,
		});
		vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('storage unavailable'));
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));

		await harness.registry.retryRecoveryDiscovery();

		expect(opened.content).toBe('recovered edit');
		expect(opened.baseline).toBe('restored base');
		expect(opened.loadedRevision).toBe('v1:restored');
		expect(opened.document.diskRevision).toBe('v1:initial');
		expect(opened.isExternallyStale).toBe(true);
		expect(opened.saveOutcomeUnknown).toBe(true);
		expect(opened.document.recoveryGuard).toBe(false);
		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		const [adopted] = await repository.getDrafts('test-user', 'test-deployment', 'test-session');
		expect(adopted?.localDocumentId).toBe(opened.document.id);
		expect(adopted?.unknownSubmission?.submissionId).toBe('unknown-save');
	});

	it('does not restore recovery records from another namespace or deployment', async () => {
		const repository = createMemoryFileDraftRepository();
		const foreign = storedDraft({
			deploymentId: 'other-deployment',
			userNamespace: 'other-user',
			browserSessionId: 'other-browser',
			documentId: 'foreign-document',
			normalizedRelativePath: 'secret.ts',
			diskRevision: null,
			baselineContent: null,
			content: 'foreign',
			closed: true,
		});
		await repository.putDraft(foreign);
		const harness = createHarness({ draftRepository: repository });

		await harness.registry.ready();

		expect(harness.registry.documents[foreign.documentId]).toBeUndefined();
	});

	it('does not restore an explicitly closed last clean view', async () => {
		const repository = createMemoryFileDraftRepository();
		const first = createHarness({ draftRepository: repository });
		const opened = await first.registry.open(request('src/closed.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		await first.registry.destroy(opened.id);

		const restored = createHarness({ draftRepository: repository });
		await restored.registry.ready();

		expect(restored.registry.all).toEqual([]);
	});

	it('initializes a side-view editor during placement publication', async () => {
		let registry!: FileSessionRegistry;
		const harness = createHarness({
			async onPublish(current) {
				registry = current;
				const published = current.all.at(-1);
				if (current.all.length > 1) {
					await vi.waitFor(() => expect(published?.editor).toBeTruthy());
				}
			},
		});
		const first = await harness.registry.open(request('src/shared.ts'));
		if (!first) throw new Error('Expected file session');
		await vi.waitFor(() => expect(first.loading).toBe(false));

		const second = await harness.registry.open({ ...request('src/shared.ts'), openToSide: true });

		expect(registry).toBe(harness.registry);
		expect(second?.editor).toBeTruthy();
	});

	it('creates a source editor when a Markdown preview enters edit mode', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('README.md'));
		if (!opened) throw new Error('Expected Markdown view');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		expect(opened.rendererMode).toBe('markdown');
		expect(opened.editor).toBeNull();

		await expect(harness.registry.showSource(opened.id)).resolves.toBe(true);

		expect(opened.rendererMode).toBe('code');
		expect(opened.editor).toBeTruthy();
	});

	it('preserves a dirty document when opening another view', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/shared.ts'));
		if (!first) throw new Error('Expected file session');
		await vi.waitFor(() => expect(first.loading).toBe(false));
		first.content = 'local edits';

		const second = await harness.registry.open({
			...request('src/shared.ts'),
			openToSide: true,
		});
		if (!second) throw new Error('Expected second view');
		await vi.waitFor(() => expect(second.editor).toBeTruthy());

		expect(second.document).toBe(first.document);
		expect(first.content).toBe('local edits');
		expect(first.dirty).toBe(true);
		expect(harness.readText).toHaveBeenCalledTimes(1);
	});

	it('leaves a shared document unchanged when side placement is cancelled', async () => {
		let placements = 0;
		const harness = createHarness({
			placement: {
				async placeFileSession(_sessionId, _target, publication) {
					placements += 1;
					if (placements > 1) return 'cancelled';
					publication.publish();
					return 'placed';
				},
				async focusFileSession() {},
			},
		});
		const first = await harness.registry.open(request('src/shared.ts'));
		if (!first) throw new Error('Expected file session');
		await vi.waitFor(() => expect(first.loading).toBe(false));
		first.content = 'local edits';

		await expect(
			harness.registry.open({ ...request('src/shared.ts'), openToSide: true }),
		).resolves.toBeNull();

		expect(first.content).toBe('local edits');
		expect(first.loading).toBe(false);
		expect(first.document.viewIds.size).toBe(1);
	});

	it('keeps clean file views open when another file opens and reuses an existing view', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/first.ts'));
		const second = await harness.registry.open(request('src/second.ts'));
		if (!first || !second) throw new Error('Expected file sessions');
		await vi.waitFor(() => expect(first.loading || second.loading).toBe(false));

		const reopened = await harness.registry.open(request('src/first.ts'));

		expect(reopened).toBe(first);
		expect(first.dirty).toBe(false);
		expect(harness.registry.all).toEqual([first, second]);
	});

	it('reuses a pending file view when another open joins its placement', async () => {
		const placement = deferred<void>();
		let publish: (() => void) | null = null;
		const harness = createHarness({
			placement: {
				async placeFileSession(_sessionId, _target, publication) {
					publish = publication.publish;
					await placement.promise;
					publication.publish();
					return 'placed';
				},
				async focusFileSession() {},
			},
		});
		const firstOpen = harness.registry.open(request('src/pending.ts'));
		await vi.waitFor(() => expect(publish).not.toBeNull());
		const secondOpen = harness.registry.open(request('src/pending.ts'));
		placement.resolve();

		const [first, reopened] = await Promise.all([firstOpen, secondOpen]);
		expect(first).not.toBeNull();
		expect(reopened).toBe(first);
		expect(harness.registry.all).toEqual([first]);
	});

	it('keeps a late Save acknowledgement settled after the soft timeout', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository, saveSoftTimeoutMs: 1 });
		const pending = deferred<{ success: true; path: string; message: string; revision: string }>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'submitted';

		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		expect(opened.saveOutcomeUnknown).toBe(true);
		opened.content = 'later edit';
		expect(opened.content).toBe('later edit');
		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		pending.resolve({
			success: true,
			path: '/workspace/src/file.ts',
			message: 'saved',
			revision: 'v1:late',
		});
		await vi.waitFor(() => expect(opened.saveOutcomeUnknown).toBe(false));

		expect(opened.document.pendingSubmission).toBeNull();
		expect(opened.baseline).toBe('submitted');
		expect(opened.content).toBe('later edit');
		expect(opened.dirty).toBe(true);
		const [draft] = await repository.getDrafts('test-user', 'test-deployment', 'test-session');
		expect(draft?.content).toBe('later edit');
		expect(draft?.unknownSubmission).toBeNull();
	});

	it('does not clear an unknown overwrite when polling sees matching content', async () => {
		const harness = createHarness({ saveSoftTimeoutMs: 1 });
		const pending = deferred<{ success: true; path: string; message: string; revision: string }>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'submitted';
		opened.isExternallyStale = true;
		const save = harness.registry.save(opened.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest).toBeTruthy());
		harness.registry.resolveOverwrite('overwrite');
		await expect(save).resolves.toBe(false);
		harness.getFileRevision.mockResolvedValueOnce({ status: 'ready', revision: 'v1:matching' });
		harness.readText.mockResolvedValueOnce({
			content: 'submitted',
			path: '/workspace/src/file.ts',
			revision: 'v1:matching',
		});

		await harness.registry.checkFreshness(opened.id);

		expect(opened.saveOutcomeUnknown).toBe(true);
		await expect(harness.registry.save(opened.id)).resolves.toBe(false);
		pending.reject(new Error('connection lost'));
	});

	it('guards a dirty refresh even when another view remains open', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/shared.ts'));
		if (!first) throw new Error('Expected file session');
		await vi.waitFor(() => expect(first.loading).toBe(false));
		await harness.registry.open({ ...request('src/shared.ts'), openToSide: true });
		first.content = 'local edits';

		const refresh = harness.registry.refresh(first.id);
		await vi.waitFor(() => expect(harness.registry.guardRequest?.reason).toBe('refresh'));
		harness.registry.resolveGuard('cancel');
		await refresh;

		expect(first.content).toBe('local edits');
	});

	it('deduplicates a bulk last-view guard by document', async () => {
		const harness = createHarness();
		const first = await harness.registry.open(request('src/shared.ts'));
		if (!first) throw new Error('Expected file session');
		await vi.waitFor(() => expect(first.loading).toBe(false));
		const second = await harness.registry.open({ ...request('src/shared.ts'), openToSide: true });
		if (!second) throw new Error('Expected second view');
		first.content = 'local edits';

		const decision = harness.registry.confirmDestructiveViews([first.id, second.id], 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBeTruthy());
		harness.registry.resolveGuard('discard');

		await expect(decision).resolves.toBe(true);
		expect(first.dirty).toBe(false);
		expect(first.content).toBe(first.baseline);
	});

	it('refuses recovery cleanup while another tab owns a protected draft', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(
			storedDraft({
				browserSessionId: 'other-tab',
				documentId: 'other-tab-draft',
				normalizedRelativePath: 'other.ts',
				diskRevision: null,
				baselineContent: '',
				content: 'protected',
			}),
		);
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();

		await expect(harness.registry.clearRecovery()).resolves.toBe(false);
		expect(await repository.getDrafts('test-user', 'test-deployment', 'other-tab')).toHaveLength(1);
	});

	it('refuses recovery cleanup while a dirty document is open', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';

		await expect(harness.registry.clearRecovery()).resolves.toBe(false);
	});

	it('guards live documents and atomically preserves drafts created during recovery cleanup', async () => {
		const repository = createMemoryFileDraftRepository();
		const clearNamespace = repository.clearNamespaceIfUnprotected.bind(repository);
		const cleanupStarted = deferred<void>();
		const releaseCleanup = deferred<void>();
		vi.spyOn(repository, 'clearNamespaceIfUnprotected').mockImplementation(async (...args) => {
			cleanupStarted.resolve();
			await releaseCleanup.promise;
			return clearNamespace(...args);
		});
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));

		const cleanup = harness.registry.clearRecovery();
		await cleanupStarted.promise;
		expect(opened.document.mutationGuarded).toBe(true);
		await repository.putDraft(
			storedDraft({
				documentId: 'concurrent-draft',
				normalizedRelativePath: 'src/concurrent.ts',
				content: 'new unsaved work',
			}),
		);
		releaseCleanup.resolve();

		await expect(cleanup).resolves.toBe(false);
		expect(opened.document.mutationGuarded).toBe(false);
		expect(await repository.getDrafts('test-user', 'test-deployment', 'test-session')).toHaveLength(
			1,
		);
	});

	it('retries a failed file read without replacing the session', async () => {
		const harness = createHarness();
		harness.readText.mockRejectedValueOnce(new Error('Read failed')).mockResolvedValueOnce({
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
