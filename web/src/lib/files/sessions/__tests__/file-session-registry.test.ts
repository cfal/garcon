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
	fileDraftKey,
	type FileDraft,
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

function storedDraft(content = 'recovered edit', path = 'file.txt'): FileDraft {
	return {
		schemaVersion: 1,
		deploymentId: 'test-deployment',
		userNamespace: 'test-user',
		documentId: fileDraftKey('test-user', 'test-deployment', '/workspace', path),
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: path,
		content,
		savedAt: 1,
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
		saveTimeoutMs?: number;
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
		saveTimeoutMs: options.saveTimeoutMs,
		onOpenError,
		onRecoveryError: options.onRecoveryError,
		isDocumentVisible: options.isDocumentVisible,
	});
	const userNamespace = options.userNamespace === undefined ? 'test-user' : options.userNamespace;
	if (userNamespace) void registry.initializeRecovery(userNamespace);
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
	it('keeps background polling out of an interactive conflict read', async () => {
		const harness = createHarness();
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'local';
		session.isExternallyStale = true;
		const revision = deferred<FileRevisionResponse>();
		const disk = deferred<Awaited<ReturnType<typeof harness.readText>>>();
		harness.getFileRevision.mockReturnValueOnce(revision.promise);
		const polling = harness.registry.checkFreshness(session.id);
		harness.readText.mockReturnValueOnce(disk.promise);
		const saving = harness.registry.save(session.id);
		const conflictController = session.document.conflictController!;
		revision.resolve({ status: 'ready', revision: 'v1:changed' });
		await polling;
		expect(conflictController.signal.aborted).toBe(false);
		expect(harness.readText).toHaveBeenCalledTimes(2);
		disk.resolve({ content: 'disk', path: '/workspace/file.txt', revision: 'v1:changed' });
		await vi.waitFor(() => expect(harness.registry.overwriteRequest?.diskContent).toBe('disk'));
		harness.registry.resolveOverwrite('save-checked');
		await expect(saving).resolves.toBe(true);
		await harness.registry.destroyAll();
	});

	it.each(['close', 'preview'] as const)(
		'ignores editor-loader completion after source view %s',
		async (action) => {
			for (const fails of [false, true]) {
				const runtime = deferred<FileEditorRuntimeModule>();
				const harness = createHarness({ loadEditorRuntime: () => runtime.promise });
				const first = (await harness.registry.open(request('README.md')))!;
				await vi.waitFor(() => expect(first.loading).toBe(false));
				const second = (await harness.registry.openToSide(first.id, 'window-main'))!;
				const source = harness.registry.showSource(second.id);
				if (action === 'close') await harness.registry.destroy(second.id);
				else second.rendererMode = 'markdown';
				if (fails) runtime.reject(new ModuleImportError(new Error('Unavailable chunk')));
				else runtime.resolve(testEditorRuntime);
				await expect(source).resolves.toBe(false);
				expect(second.editor).toBeNull();
				expect(first.loadError).toBeNull();
				expect(first.document.editorInitializationFailed).toBe(false);
				await harness.registry.destroyAll();
			}
		},
	);

	it.each([false, true])(
		'rejects placement completing after teardown (published: %s)',
		async (published) => {
			const started = deferred<void>();
			const placed = deferred<void>();
			const harness = createHarness({
				placement: {
					async placeFileSession(_id, _target, publication) {
						if (published) publication.publish();
						started.resolve();
						await placed.promise;
						publication.publish();
						return 'placed';
					},
					async focusFileSession() {},
				},
			});
			const opening = harness.registry.open(request('file.txt'));
			await started.promise;
			await harness.registry.destroyAll();
			placed.resolve();
			await expect(opening).resolves.toBeNull();
			expect(harness.registry.all).toEqual([]);
			expect(harness.registry.documents).toEqual({});
			expect(harness.readText).not.toHaveBeenCalled();
			expect(harness.getFileRevision).not.toHaveBeenCalled();
		},
	);

	it('cancels threshold and queued opens during teardown', async () => {
		const harness = createHarness();
		for (let index = 0; index < FILE_SESSION_SOFT_LIMIT; index++) {
			await harness.registry.open(request(`file-${index}.md`));
		}
		const first = harness.registry.open(request('over-limit.md'));
		await vi.waitFor(() => expect(harness.registry.thresholdRequest).not.toBeNull());
		const second = harness.registry.open(request('queued.md'));
		await harness.registry.destroyAll();
		expect(harness.registry.thresholdRequest).toBeNull();
		await expect(first).resolves.toBeNull();
		await expect(second).resolves.toBeNull();
	});

	it.each([
		{ outcome: 'cancelled', published: false },
		{ outcome: 'cancelled', published: true },
		{ outcome: 'throw', published: false },
		{ outcome: 'throw', published: true },
	] as const)(
		'tears down the last pending placement on $outcome (published: $published)',
		async ({ outcome, published }) => {
			const started = deferred<void>();
			const finish = deferred<void>();
			let placements = 0;
			const repository = createMemoryFileDraftRepository();
			const harness = createHarness({
				draftRepository: repository,
				placement: {
					async placeFileSession(_id, _target, publication) {
						if (++placements === 1) {
							publication.publish();
							return 'placed';
						}
						if (published) publication.publish();
						started.resolve();
						await finish.promise;
						if (outcome === 'throw') throw new Error('Placement failed');
						return outcome;
					},
					async focusFileSession() {},
				},
			});
			const first = (await harness.registry.open(request('file.txt')))!;
			await vi.waitFor(() => expect(first.loading).toBe(false));
			first.content = 'unsaved';
			const disposed = vi.spyOn(first.document, 'dispose');
			const side = harness.registry.openToSide(first.id, 'window-main');
			await started.promise;
			await harness.registry.destroy(first.id);
			finish.resolve();
			if (outcome === 'throw') await expect(side).rejects.toThrow('Placement failed');
			else await expect(side).resolves.toBeNull();
			expect(first.document.viewIds.size).toBe(0);
			expect(harness.registry.documents).toEqual({});
			expect(harness.registry.hasUnloadProtectedSessions).toBe(false);
			expect(disposed).toHaveBeenCalledOnce();
			await harness.registry.flushRecovery();
			expect((await repository.getDrafts('test-user', 'test-deployment'))[0]?.content).toBe(
				'unsaved',
			);
			await harness.registry.destroyAll();
		},
	);

	it('replaces a document closed while its side-open recovery prompt is pending', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(storedDraft());
		vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('Storage unavailable'));
		const harness = createHarness({ draftRepository: repository });
		harness.readText.mockRejectedValueOnce(new Error('Read failed'));
		const first = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(first.loadError).toBe('Read failed'));
		await harness.registry.retryRecoveryDiscovery();
		const side = harness.registry.openToSide(first.id, 'window-main');
		await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
		await harness.registry.destroy(first.id);
		harness.registry.resolveDraft('resume');
		const second = (await side)!;
		expect(harness.registry.documents[second.documentId]).toBe(second.document);
		await vi.waitFor(() => expect(second.content).toBe('recovered edit'));
		expect(harness.registry.hasUnloadProtectedSessions).toBe(true);
		await expect(harness.registry.open(request('file.txt'))).resolves.toBe(second);
		await harness.registry.destroyAll();
	});

	it('checkpoints edits made before authenticated recovery initialization', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository, userNamespace: null });
		const opened = (await harness.registry.open(request('early.txt')))!;
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'early edit';
		await harness.registry.initializeRecovery('test-user');
		await harness.registry.flushRecovery();
		expect((await repository.getDrafts('test-user', 'test-deployment'))[0]?.content).toBe(
			'early edit',
		);
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
		await harness.registry.flushRecovery();
		expect(onRecoveryError).toHaveBeenCalledWith(opened.document, error);
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
			expect((await repository.getDrafts('test-user', 'test-deployment'))[0]?.content).toBe(
				'recovered edit',
			);
			await harness.registry.destroyAll();
		},
	);

	it.each(['saved', 'rejected', 'detached'] as const)(
		'releases active Save state after %s',
		async (outcome) => {
			const harness = createHarness({ saveTimeoutMs: 5 });
			const opened = await harness.registry.open(request('reservation.ts'));
			if (!opened) throw new Error('Expected file');
			await vi.waitFor(() => expect(opened.loading).toBe(false));
			opened.content = 'local';
			const pending = deferred<Awaited<ReturnType<typeof harness.saveText>>>();
			harness.saveText.mockReturnValueOnce(pending.promise);
			const save = harness.registry.save(opened.id);
			await vi.waitFor(() => expect(harness.saveText).toHaveBeenCalledOnce());
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
			await vi.waitFor(() => expect(opened.document.saveController).toBeNull());
			expect(opened.saving).toBe(false);
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
			first.document.saving = true;
			registry.reloadApplication();
			expect(reloadApplication).not.toHaveBeenCalled();
			const publishedViews = registry.sessions;
			registry.sessions = { [second.id]: second };
			registry.reloadApplication();
			expect(reloadApplication).not.toHaveBeenCalled();
			first.document.saving = false;
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

	it('reloads a failed editor module only on explicit Retry, not an existing-file open', async () => {
		const reloadApplication = vi.fn();
		const loadEditorRuntime = vi
			.fn<() => Promise<FileEditorRuntimeModule>>()
			.mockRejectedValue(new ModuleImportError(new Error('Editor chunk unavailable')));
		const harness = createHarness({ loadEditorRuntime, reloadApplication });

		const opened = await harness.registry.open(request('src/reload-required.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loadError).toBe('Editor chunk unavailable'));
		expect(opened.loadErrorRequiresPageReload).toBe(true);

		await expect(harness.registry.open(request('src/reload-required.ts'))).resolves.toBe(opened);
		expect(harness.focusCalls).toEqual([opened.id]);
		expect(reloadApplication).not.toHaveBeenCalled();

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

	it('reopens without waiting for last-view backup cleanup and orders the next checkpoint', async () => {
		const repository = createMemoryFileDraftRepository();
		const allowDelete = deferred<void>();
		const deleteDraft = repository.deleteDraft.bind(repository);
		repository.deleteDraft = vi.fn(async (documentId) => {
			await allowDelete.promise;
			await deleteDraft(documentId);
		});
		const harness = createHarness({ draftRepository: repository });
		const opened = await harness.registry.open(request('src/reopen.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));

		await harness.registry.destroy(opened.id);
		const reopened = await harness.registry.open(request('src/reopen.ts'));
		if (!reopened) throw new Error('Expected reopened file session');
		await vi.waitFor(() => expect(reopened.loading).toBe(false));
		expect(harness.registry.documents[reopened.document.id]).toBe(reopened.document);
		expect(reopened.document.editorRuntime).not.toBeNull();
		reopened.content = 'reopened edit';
		allowDelete.resolve();
		await harness.registry.flushRecovery();
		expect(await repository.getDrafts('test-user', 'test-deployment')).toHaveLength(1);
	});

	it('rechecks teardown after a same-identity side open waits in the creation queue', async () => {
		const repository = createMemoryFileDraftRepository();
		const allowPlacement = deferred<void>();
		const allowDelete = deferred<void>();
		const deleteDraft = repository.deleteDraft.bind(repository);
		repository.deleteDraft = vi.fn(async (documentId) => {
			await allowDelete.promise;
			await deleteDraft(documentId);
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
		await vi.waitFor(() => expect(repository.deleteDraft).toHaveBeenCalledOnce());

		allowPlacement.resolve();
		await blocker;
		await destruction;
		const reopened = await reopening;
		if (!reopened) throw new Error('Expected reopened file session');
		await vi.waitFor(() => expect(reopened.loading).toBe(false));
		expect(placementCount).toBe(3);
		expect(harness.registry.documents[reopened.document.id]).toBe(reopened.document);
		expect(reopened.document).not.toBe(original.document);
		expect(reopened.document.editorRuntime).not.toBeNull();
		allowDelete.resolve();
		await harness.registry.flushRecovery();
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

	it('admits a discard close without waiting for backup deletion', async () => {
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
		const release = await closing;
		expect(release).toBeTypeOf('function');
		release?.();
		opened.content = 'new edit after discard';
		deletion.resolve();
		await harness.registry.flushRecovery();
		expect(opened.content).toBe('new edit after discard');
		expect(opened.dirty).toBe(true);
		expect((await repository.getDrafts('test-user', 'test-deployment'))[0].content).toBe(
			'new edit after discard',
		);
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
		const closing = harness.registry.prepareDestructiveViews([first.id, second.id], 'close');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(first.id));
		harness.registry.resolveGuard('discard');
		await vi.waitFor(() => expect(harness.registry.guardRequest?.sessionId).toBe(second.id));
		first.content = 'new edit during the second decision';
		harness.registry.resolveGuard('discard');

		await expect(closing).resolves.toBeNull();
		expect(first.content).toBe('new edit during the second decision');
		expect(first.dirty).toBe(true);
	});

	it('allows discard despite failed backup cleanup', async () => {
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
		const release = await failed;
		expect(release).toBeTypeOf('function');
		expect(first.document.recoveryError).toBe('quota');
		release?.();
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
		expect(opened.saving).toBe(false);

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
		harness.registry.resolveOverwrite('save-checked', 'merged local');

		await expect(save).resolves.toBe(true);
		expect(harness.saveText).toHaveBeenCalledOnce();
		expect(harness.saveText).toHaveBeenCalledWith(
			{
				projectPath: '/workspace',
				filePath: 'src/file.ts',
				content: 'merged local',
				expectedRevision: 'v1:initial',
				conflictResolution: 'reject',
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
		harness.registry.resolveOverwrite('save-checked');
		await expect(save).resolves.toBe(true);

		expect(harness.saveText).toHaveBeenCalledTimes(2);
		expect(harness.saveText).toHaveBeenLastCalledWith(
			{
				projectPath: '/workspace',
				filePath: 'src/file.ts',
				content: 'local',
				expectedRevision: 'v1:initial',
				conflictResolution: 'reject',
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
		harness.registry.resolveOverwrite('save-checked', 'normalized overwrite');
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
		harness.getFileRevision.mockResolvedValueOnce({ status: 'ready', revision: 'v1:r4' });
		await harness.registry.checkFreshness(opened.id);
		expect(harness.readText).toHaveBeenCalledTimes(2);
		expect(harness.registry.overwriteRequest?.diskRevision).toBe('v1:r3');
		harness.registry.resolveOverwrite('save-checked', 'merged');
		await compare;

		expect(harness.saveText).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'merged', expectedRevision: 'v1:r3' }),
			{ signal: expect.any(AbortSignal), timeoutMs: null },
		);
		expect(opened.content).toBe('merged');
		expect(opened.dirty).toBe(false);
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
		harness.registry.resolveOverwrite('save-checked');

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

	it('refuses recovery cleanup while a dirty document is open', async () => {
		const harness = createHarness();
		const opened = await harness.registry.open(request('src/file.ts'));
		if (!opened) throw new Error('Expected file session');
		await vi.waitFor(() => expect(opened.loading).toBe(false));
		opened.content = 'local';

		await expect(harness.registry.clearRecovery()).resolves.toBe(false);
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

describe('best-effort file recovery', () => {
	it.each(['cancel', 'resume'] as const)(
		'focuses an existing failed view before the recovery prompt and disk read (%s)',
		async (choice) => {
			const repository = createMemoryFileDraftRepository();
			await repository.putDraft(storedDraft());
			vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('Storage unavailable'));
			const harness = createHarness({ draftRepository: repository });
			harness.readText.mockRejectedValueOnce(new Error('Read failed'));
			const session = (await harness.registry.open(request('file.txt')))!;
			await vi.waitFor(() => expect(session.loadError).toBe('Read failed'));
			await harness.registry.retryRecoveryDiscovery();
			const disk = deferred<Awaited<ReturnType<typeof harness.readText>>>();
			harness.readText.mockReturnValueOnce(disk.promise);

			const reopening = harness.registry.open(request('file.txt'));
			await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
			expect(harness.focusCalls).toEqual([session.id]);
			expect(harness.readText).toHaveBeenCalledOnce();
			harness.registry.resolveDraft(choice);
			if (choice === 'resume') {
				await vi.waitFor(() => expect(harness.readText).toHaveBeenCalledTimes(2));
				expect(harness.focusCalls).toEqual([session.id]);
				disk.resolve({ content: 'initial', path: '/workspace/file.txt', revision: 'v1:initial' });
			}
			await expect(reopening).resolves.toBe(session);
			expect(session.content).toBe(choice === 'resume' ? 'recovered edit' : '');
			expect(harness.registry.recoveredDrafts).toHaveLength(choice === 'cancel' ? 1 : 0);
			await harness.registry.destroyAll();
		},
	);

	it.each(['close', 'open', 'reload', 'refresh', 'side'] as const)(
		'preserves late-discovered backups after a failed load (%s)',
		async (action) => {
			const repository = createMemoryFileDraftRepository();
			await repository.putDraft(storedDraft());
			vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('Storage unavailable'));
			const harness = createHarness({ draftRepository: repository });
			harness.readText.mockRejectedValueOnce(new Error('Read failed'));
			const session = (await harness.registry.open(request('file.txt')))!;
			await vi.waitFor(() => expect(session.loadError).toBe('Read failed'));
			await harness.registry.retryRecoveryDiscovery();
			expect(harness.registry.recoveredDrafts).toHaveLength(1);
			await harness.registry.flushRecovery();
			if (action === 'close') {
				await harness.registry.destroy(session.id);
				await harness.registry.flushRecovery();
				expect((await repository.getDrafts('test-user', 'test-deployment'))[0].content).toBe(
					'recovered edit',
				);
			} else {
				let recovery: Promise<unknown>;
				if (action === 'reload') recovery = harness.registry.reload(session.id);
				else if (action === 'refresh') recovery = harness.registry.refresh(session.id);
				else
					recovery = harness.registry.open({
						...request('file.txt'),
						openToSide: action === 'side',
					});
				await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
				harness.registry.resolveDraft('resume');
				await recovery;
				await vi.waitFor(() => expect(session.content).toBe('recovered edit'));
				expect(session.dirty).toBe(true);
				await vi.waitFor(() => expect(harness.registry.recoveredDrafts).toEqual([]));
			}
			await harness.registry.destroyAll();
		},
	);

	it.each(['cancel', 'discard'] as const)(
		'allows %s of a late-discovered backup on Retry',
		async (choice) => {
			const repository = createMemoryFileDraftRepository();
			await repository.putDraft(storedDraft());
			vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('Storage unavailable'));
			const harness = createHarness({ draftRepository: repository });
			harness.readText.mockRejectedValueOnce(new Error('Read failed'));
			const session = (await harness.registry.open(request('file.txt')))!;
			await vi.waitFor(() => expect(session.loadError).toBe('Read failed'));
			await harness.registry.retryRecoveryDiscovery();
			const recovery = harness.registry.reload(session.id);
			await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
			harness.registry.resolveDraft(choice);
			await recovery;
			await harness.registry.flushRecovery();
			expect(harness.readText).toHaveBeenCalledTimes(choice === 'cancel' ? 1 : 2);
			expect(harness.registry.recoveredDrafts).toHaveLength(choice === 'cancel' ? 1 : 0);
			expect(await repository.getDrafts('test-user', 'test-deployment')).toHaveLength(
				choice === 'cancel' ? 1 : 0,
			);
			await harness.registry.destroyAll();
		},
	);

	it('deletes a stale backup discovered after a clean buffer has loaded', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(storedDraft());
		vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('Storage unavailable'));
		const harness = createHarness({ draftRepository: repository });
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		await harness.registry.retryRecoveryDiscovery();
		await harness.registry.flushRecovery();
		expect(harness.registry.recoveredDrafts).toEqual([]);
		expect(await repository.getDrafts('test-user', 'test-deployment')).toEqual([]);
		await harness.registry.destroyAll();
	});

	it('opens a discarded backup without waiting for storage deletion', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(storedDraft());
		const deletion = deferred<void>();
		const remove = repository.deleteDraft.bind(repository);
		vi.spyOn(repository, 'deleteDraft').mockImplementationOnce(async (id) => {
			await deletion.promise;
			await remove(id);
		});
		const harness = createHarness({ draftRepository: repository });
		const opening = harness.registry.open(request('file.txt'));
		await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
		harness.registry.resolveDraft('discard');
		const session = (await opening)!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		expect(harness.registry.recoveredDrafts).toEqual([]);
		session.content = 'new local edit';
		deletion.resolve();
		await harness.registry.flushRecovery();
		expect((await repository.getDrafts('test-user', 'test-deployment'))[0].content).toBe(
			'new local edit',
		);
		await harness.registry.destroyAll();
	});

	it('releases Save after Accept Disk without waiting for backup deletion', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository });
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'local edit';
		session.isExternallyStale = true;
		const deletion = deferred<void>();
		vi.spyOn(repository, 'deleteDraft').mockReturnValueOnce(deletion.promise);
		const save = harness.registry.save(session.id);
		await vi.waitFor(() => expect(harness.registry.overwriteRequest).not.toBeNull());
		harness.registry.resolveOverwrite('accept-disk');
		await expect(save).resolves.toBe(false);
		expect(session.saving).toBe(false);
		expect(session.content).toBe('initial');
		await harness.registry.destroyAll();
		deletion.resolve();
		await harness.registry.flushRecovery();
	});

	it('reports a real cleanup storage failure separately from dirty-file blocking', async () => {
		const repository = createMemoryFileDraftRepository();
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		vi.spyOn(repository, 'clearDrafts').mockRejectedValueOnce(new Error('Storage blocked'));
		await expect(harness.registry.clearRecovery()).rejects.toThrow('Storage blocked');
		expect(harness.registry.recoveryError).toBe('Storage blocked');
		await expect(harness.registry.clearRecovery()).resolves.toBe(true);
		await harness.registry.destroyAll();
	});

	it.each(['retry', 'refresh', 'close'] as const)(
		'retains a selected draft after a read failure and %s',
		async (action) => {
			const repository = createMemoryFileDraftRepository();
			await repository.putDraft(storedDraft());
			const harness = createHarness({ draftRepository: repository });
			harness.readText.mockRejectedValueOnce(new Error('Read failed'));
			const opening = harness.registry.open(request('file.txt'));
			await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
			harness.registry.resolveDraft('resume');
			const session = (await opening)!;
			await vi.waitFor(() => expect(session.loading).toBe(false));
			expect(session.loadError).toBe('Read failed');
			await harness.registry.flushRecovery();
			await harness.registry.retryRecoveryDiscovery();
			expect(harness.registry.recoveredDrafts).toHaveLength(1);
			if (action !== 'close') {
				if (action === 'retry') await harness.registry.reload(session.id);
				else await harness.registry.refresh(session.id);
				expect(session.content).toBe('recovered edit');
				expect(session.baseline).toBe('initial');
				expect(session.dirty).toBe(true);
				expect(session.document.pendingRecoveryContent).toBeNull();
				expect(harness.registry.recoveredDrafts).toEqual([]);
			} else {
				await harness.registry.destroy(session.id);
			}
			await harness.registry.flushRecovery();
			expect((await repository.getDrafts('test-user', 'test-deployment'))[0]?.content).toBe(
				'recovered edit',
			);
			await harness.registry.destroyAll();
		},
	);

	it('removes a resumed backup already identical to disk', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(storedDraft('initial'));
		const harness = createHarness({ draftRepository: repository });
		const opening = harness.registry.open(request('file.txt'));
		await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
		harness.registry.resolveDraft('resume');
		const session = (await opening)!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		await harness.registry.flushRecovery();
		expect(session.dirty).toBe(false);
		expect(await repository.getDrafts('test-user', 'test-deployment')).toEqual([]);
		await harness.registry.destroyAll();
	});

	it('clears a pending Resume when stored drafts are explicitly cleared', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(storedDraft());
		const harness = createHarness({ draftRepository: repository });
		harness.readText.mockRejectedValueOnce(new Error('Read failed'));
		const opening = harness.registry.open(request('file.txt'));
		await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
		harness.registry.resolveDraft('resume');
		const session = (await opening)!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		await expect(harness.registry.clearRecovery()).resolves.toBe(true);
		await harness.registry.reload(session.id);
		expect(session.content).toBe('initial');
		expect(session.dirty).toBe(false);
		expect(harness.registry.recoveredDrafts).toEqual([]);
		expect(await repository.getDrafts('test-user', 'test-deployment')).toEqual([]);
		await harness.registry.destroyAll();
	});

	it('excludes live buffers when discovery is retried', async () => {
		const repository = createMemoryFileDraftRepository();
		vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error('Storage unavailable'));
		const harness = createHarness({ draftRepository: repository });
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'live edit';
		await harness.registry.flushRecovery();
		await harness.registry.retryRecoveryDiscovery();
		expect(harness.registry.recoveredDrafts).toEqual([]);
		expect(session.content).toBe('live edit');
		await harness.registry.destroyAll();
	});

	it('prunes a backup discovered while file placement is pending', async () => {
		const repository = createMemoryFileDraftRepository();
		const draft = storedDraft();
		await repository.putDraft(draft);
		const discovery = deferred<FileDraft[]>();
		vi.spyOn(repository, 'getDrafts')
			.mockRejectedValueOnce(new Error('Storage unavailable'))
			.mockReturnValueOnce(discovery.promise);
		const placementStarted = deferred<void>();
		const placementReady = deferred<void>();
		const harness = createHarness({
			draftRepository: repository,
			placement: {
				async placeFileSession(_sessionId, _target, publication) {
					placementStarted.resolve();
					await placementReady.promise;
					publication.publish();
					return 'placed';
				},
				async focusFileSession() {},
			},
		});
		const opening = harness.registry.open(request('file.txt'));
		await placementStarted.promise;
		const retry = harness.registry.retryRecoveryDiscovery();
		discovery.resolve([draft]);
		await retry;
		expect(harness.registry.all).toEqual([]);
		expect(harness.registry.recoveredDrafts).toHaveLength(1);
		placementReady.resolve();
		const session = (await opening)!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		expect(harness.registry.recoveredDrafts).toEqual([]);
		session.content = 'saved edit';
		await expect(harness.registry.save(session.id)).resolves.toBe(true);
		await harness.registry.destroy(session.id);
		const reopened = await harness.registry.open(request('file.txt'));
		expect(reopened).not.toBeNull();
		expect(harness.registry.draftRequest).toBeNull();
		await harness.registry.destroyAll();
	});

	it.each(['resume', 'discard'] as const)(
		'offers %s before opening a stored draft for editing',
		async (choice) => {
			const repository = createMemoryFileDraftRepository();
			await repository.putDraft(storedDraft());
			const harness = createHarness({ draftRepository: repository });
			await harness.registry.ready();
			expect(harness.registry.all).toEqual([]);
			expect(harness.registry.recoveredDrafts).toHaveLength(1);
			const opening = harness.registry.open(request('file.txt'));
			await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
			expect(harness.registry.all).toEqual([]);
			harness.registry.resolveDraft(choice);
			const session = (await opening)!;
			await vi.waitFor(() => expect(session.loading).toBe(false));
			expect(session.content).toBe(choice === 'resume' ? 'recovered edit' : 'initial');
			expect(session.dirty).toBe(choice === 'resume');
			expect(harness.saveText).not.toHaveBeenCalled();
			expect(harness.registry.recoveredDrafts).toEqual([]);
			const side = await harness.registry.open({ ...request('file.txt'), openToSide: true });
			expect(side?.document).toBe(session.document);
			expect(harness.registry.draftRequest).toBeNull();
			await harness.registry.destroyAll();
		},
	);

	it('keeps a cancelled recovery choice available without creating a document', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(storedDraft());
		const harness = createHarness({ draftRepository: repository });
		const opening = harness.registry.open(request('file.txt'));
		await vi.waitFor(() => expect(harness.registry.draftRequest).not.toBeNull());
		harness.registry.resolveDraft('cancel');
		await expect(opening).resolves.toBeNull();
		expect(harness.registry.recoveredDrafts).toHaveLength(1);
		expect(Object.keys(harness.registry.documents)).toEqual([]);
		await harness.registry.destroyAll();
	});

	it('opens and saves even when recovery discovery fails', async () => {
		const repository = createMemoryFileDraftRepository();
		vi.spyOn(repository, 'getDrafts').mockRejectedValueOnce(new Error(''));
		const harness = createHarness({ draftRepository: repository });
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		expect(harness.registry.recoveryError).toBeTruthy();
		session.content = 'local';
		await expect(harness.registry.save(session.id)).resolves.toBe(true);
		expect(session.document.mutationGuarded).toBe(false);
		await harness.registry.retryRecoveryDiscovery();
		expect(harness.registry.recoveryError).toBeNull();
		await harness.registry.destroyAll();
	});

	it.each([false, true])(
		'saves without recovery storage, including failed cleanup (durable: %s)',
		async (durable) => {
			const repository = createMemoryFileDraftRepository(durable);
			vi.spyOn(repository, 'putDraft').mockRejectedValue(new Error('quota'));
			vi.spyOn(repository, 'deleteDraft').mockRejectedValue(new Error('quota'));
			const harness = createHarness({ draftRepository: repository });
			const session = (await harness.registry.open(request('file.txt')))!;
			await vi.waitFor(() => expect(session.loading).toBe(false));
			session.content = 'local';
			await harness.registry.flushRecovery();
			await expect(harness.registry.save(session.id)).resolves.toBe(true);
			await harness.registry.flushRecovery();
			expect(session.content).toBe('local');
			expect(session.dirty).toBe(false);
			expect(session.saving).toBe(false);
			expect(session.saveError).toBeNull();
			expect(session.document.recoveryError).toBeTruthy();
			expect(session.document.mutationGuarded).toBe(false);
			await harness.registry.destroyAll();
		},
	);

	it.each([403, 404, 500])('allows retry or discard after HTTP %s', async (status) => {
		const harness = createHarness();
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'local';
		harness.saveText.mockRejectedValueOnce(new ApiError(status, 'Save failed'));
		await expect(harness.registry.save(session.id)).resolves.toBe(false);
		expect(session.dirty).toBe(true);
		expect(session.saving).toBe(false);
		expect(session.document.mutationGuarded).toBe(false);
		await expect(harness.registry.save(session.id)).resolves.toBe(true);
		await harness.registry.destroyAll();
	});

	it('releases a timed-out Save and ignores its late response after retry', async () => {
		const harness = createHarness({ saveTimeoutMs: 5 });
		const session = (await harness.registry.open(request('file.txt')))!;
		await vi.waitFor(() => expect(session.loading).toBe(false));
		session.content = 'submitted';
		const pending = deferred<Awaited<ReturnType<typeof harness.saveText>>>();
		harness.saveText.mockReturnValueOnce(pending.promise);
		await expect(harness.registry.save(session.id)).resolves.toBe(false);
		expect(session.saving).toBe(false);
		expect(session.document.mutationGuarded).toBe(false);
		expect(session.saveError).toContain('not confirmed');
		session.content = 'newer edit';
		await expect(harness.registry.save(session.id)).resolves.toBe(true);
		pending.resolve({
			success: true,
			path: '/workspace/file.txt',
			message: 'saved',
			revision: 'v1:late',
		});
		await Promise.resolve();
		expect(session.content).toBe('newer edit');
		expect(session.baseline).toBe('newer edit');
		expect(session.loadedRevision).toBe('v1:saved');
		await harness.registry.destroyAll();
	});

	it('allows explicitly clearing stored drafts without cross-tab ownership locks', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(storedDraft());
		const harness = createHarness({ draftRepository: repository });
		await harness.registry.ready();
		await expect(harness.registry.clearRecovery()).resolves.toBe(true);
		expect(harness.registry.recoveredDrafts).toEqual([]);
		expect(await repository.getDrafts('test-user', 'test-deployment')).toEqual([]);
		await harness.registry.destroyAll();
	});
});
