import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { createGhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import {
	createLocalSettingsStore,
	type LocalSettingsStore,
} from '$lib/stores/local-settings.svelte.js';
import { createModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import { createNavigationStore } from '$lib/stores/navigation.svelte.js';
import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';
import type { ChatListEntry } from '$shared/chat-list';
import type { ProjectTarget } from '$shared/project-resolution';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import { createChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub.js';
import { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';
import { windowIdOfSurface, windowNodeById } from '../window-tree.js';
import { FILE_SHORTCUT_COMMANDS } from '../workspace-shortcuts.js';
import { FileSession } from '$lib/files/sessions/__tests__/file-session-fixture.js';
import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileViewRecovery } from '$lib/files/persistence/file-view-recovery.js';
import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
import * as draftRepositories from '$lib/files/persistence/file-draft-repository.js';
import { FILE_RECOVERY_DEPLOYMENT_ID } from '$lib/files/persistence/file-recovery-identity.js';
import {
	MIN_WINDOW_WIDTH_PX,
	WORKSPACE_RESIZE_BOUND_SAFETY_PX,
} from '../window-geometry-policy.js';
import {
	createWorkspaceServices,
	resolveConfiguredFilePlacement,
	type WorkspaceServices,
} from '../workspace-services.js';

vi.mock('$lib/api/files.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/files.js')>();
	return {
		...actual,
		resolveFileIdentity: vi.fn(
			async ({
				projectPath,
				relativePath,
			}: {
				projectPath: string | null;
				relativePath: string;
			}) => ({
				success: true as const,
				identity: {
					canonicalFileRootPath: projectPath ?? '/workspace',
					normalizedRelativePath: relativePath,
				},
			}),
		),
		readText: vi.fn(async ({ filePath }: { filePath: string }) => ({
			content: '',
			path: `/workspace/${filePath}`,
			revision: `v1:${filePath}`,
		})),
	};
});

const projectResolutionApiMocks = vi.hoisted(() => ({ resolveProject: vi.fn() }));

vi.mock('$lib/api/project-resolution.js', () => ({
	resolveProject: projectResolutionApiMocks.resolveProject,
}));

const DEFAULT_WINDOW: WorkspaceWindowId = 'window-main';
const OTHER_WINDOW: WorkspaceWindowId = 'window-2';

function makeChatEntry(overrides: Partial<ChatListEntry> = {}): ChatListEntry {
	return {
		id: '1788698026082000',
		parentChat: null,
		agentId: 'codex',
		agentOwnershipEpoch: 'epoch-1',
		model: 'default',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
		title: 'Project chat',
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		tags: [],
		activity: {
			createdAt: '2026-09-06T00:00:00.000Z',
			lastActivityAt: '2026-09-06T00:00:00.000Z',
			lastReadAt: '2026-09-06T00:00:00.000Z',
		},
		preview: { lastMessage: 'Initial preview' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
		...overrides,
	};
}

function assembleWorkspaceServices(
	localSettings: LocalSettingsStore,
	fileWorkspaceLayoutRaw: string | null = null,
	clientId: string | null = 'test-client',
): {
	services: WorkspaceServices;
	ghCapability: ReturnType<typeof createGhCapabilityStore>;
	chatSessions: ReturnType<typeof createChatSessionsStore>;
} {
	const ghCapability = createGhCapabilityStore();
	const chatSessions = createChatSessionsStore();
	ghCapability.hasChecked = true;
	ghCapability.available = true;
	const ws = {
		isConnected: false,
		sendMessage: () => false,
		addMessageConsumer: () => () => undefined,
		onConnectionChange: () => () => undefined,
	} satisfies PrimaryWsConnectionPort;
	const services = createWorkspaceServices({
		appShell: createAppShellStore(),
		chatBoardInvalidations: createChatBoardInvalidationHub(),
		ticketsInvalidations: new TicketsInvalidationHub(),
		chatSessions,
		ghCapability,
		localSettings,
		modelCatalog: createModelCatalogStore(),
		navigation: createNavigationStore(),
		notifications: createNotificationsStore(),
		terminalIdentity: { clientId },
		ws,
		getRouteIdentity: () => '/',
		onTerminalLauncherDismissed: () => {},
		isTerminalLauncherDismissed: () => false,
		workspaceLayoutRaw: null,
		fileWorkspaceLayoutRaw,
	});
	if (clientId) void services.files.initializeRecovery('test-user', clientId);
	return { services, ghCapability, chatSessions };
}

describe('createWorkspaceServices', () => {
	let services: WorkspaceServices | null = null;
	let rootLocalSettings: LocalSettingsStore | null = null;

	afterEach(() => {
		services?.destroy();
		services = null;
		rootLocalSettings?.destroy();
		rootLocalSettings = null;
		projectResolutionApiMocks.resolveProject.mockReset();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('uses the write-admission policy for palette and shortcut Save commands', async () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const session = new FileSession(
			{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
			'command-save',
		);
		session.rendererMode = 'code';
		session.loading = false;
		session.dirty = true;
		session.loadedRevision = 'v1:loaded';
		vi.spyOn(services.files, 'get').mockReturnValue(session);
		const save = vi.spyOn(services.files, 'save').mockResolvedValue(true);
		const context = { viewId: session.id, surfaceId: `file:${session.id}` };
		expect(services.commands.isEnabled('file.save', context)).toBe(true);
		await expect(services.commands.execute('file.save', context)).resolves.toBe(true);
		expect(save).toHaveBeenCalledOnce();

		for (const guard of [
			{ dirty: false },
			{ loading: true },
			{ refreshing: true },
			{ readOnly: true },
			{ mixedLineEndings: true },
			{ loadedRevision: null },
			{ recoveryGuard: true },
			{ pendingMutationCount: 1 },
			{ saveOutcome: 'saving' },
			{ saveOutcome: 'unknown' },
		] satisfies Partial<FileDocumentState>[]) {
			const original = Object.fromEntries(
				Object.keys(guard).map((key) => [key, Reflect.get(session.document, key)]),
			);
			Object.assign(session.document, guard);
			expect(services.commands.isEnabled('file.save', context), JSON.stringify(guard)).toBe(false);
			await expect(services.commands.execute('file.save', context)).resolves.toBe(false);
			Object.assign(session.document, original);
		}
		expect(save).toHaveBeenCalledOnce();
	});

	it('uses editor admission for every palette and shortcut editor command', async () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const session = new FileSession(
			{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.txt' },
			'command-editor',
		);
		session.content = 'local text';
		const controller = new CodeEditorController(session, {
			editorThemeId: 'standard-light',
			wordWrap: false,
			showLineNumbers: true,
			fontSize: 14,
		});
		session.editor = controller;
		vi.spyOn(services.files, 'get').mockReturnValue(session);
		const host = document.createElement('div');
		document.body.append(host);
		const context = { viewId: session.id, surfaceId: `file:${session.id}` };
		const commands = services.commands.commands.filter((command) => command.category === 'Editor');
		try {
			for (const command of commands) expect(command.isEnabled(context)).toBe(false);
			controller.attach(host);
			const run = vi.spyOn(controller, 'run');
			for (const guard of [
				{ readOnly: true },
				{ refreshing: true },
				{ mixedLineEndings: true },
				{ recoveryGuard: true },
				{ resolvingRecovery: true },
				{
					recoveredCopies: [
						{ id: 'copy', content: 'recovered', savedAt: 1, hasUnknownSubmission: false },
					],
				},
			] satisfies Partial<FileDocumentState>[]) {
				const original = Object.fromEntries(
					Object.keys(guard).map((key) => [key, Reflect.get(session.document, key)]),
				);
				Object.assign(session.document, guard);
				for (const command of commands) {
					const permitted = [
						'editor.find',
						'editor.go-to-line',
						'editor.go-to-matching-bracket',
						'editor.fold',
						'editor.unfold',
						'editor.fold-all',
						'editor.unfold-all',
						'editor.select-next-occurrence',
					].includes(command.id);
					expect(command.isEnabled(context), command.id).toBe(permitted);
					if (!permitted)
						await expect(services.commands.execute(command.id, context)).resolves.toBe(false);
				}
				Object.assign(session.document, original);
			}
			expect(run).not.toHaveBeenCalled();
			for (const saveOutcome of ['idle', 'saving', 'unknown'] as const) {
				session.document.saveOutcome = saveOutcome;
				for (const command of commands) expect(command.isEnabled(context), command.id).toBe(true);
			}
		} finally {
			controller.dispose();
			session.dispose();
			host.remove();
		}
	});

	it.each([
		['code', 'window-main'],
		['image', 'window-main'],
		['markdown', 'window-2'],
	] as const)('resolves source placement for %s from origin %s', (mode, origin) => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(
			resolveConfiguredFilePlacement(
				localSettings,
				mode,
				origin as WorkspaceWindowId,
				DEFAULT_WINDOW,
			),
		).toEqual({ type: 'window', windowId: origin });

		localSettings.destroy();
	});

	it('resolves fixed placements independent of origin and observes setting changes', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		localSettings.set('textEditorOpenPlacement', 'new-window');
		localSettings.set('imageViewerOpenPlacement', 'same-window');
		localSettings.set('markdownViewerOpenPlacement', 'dialog');

		expect(resolveConfiguredFilePlacement(localSettings, 'code', 'dialog', DEFAULT_WINDOW)).toEqual(
			{ type: 'new-window', anchorWindowId: DEFAULT_WINDOW },
		);
		expect(
			resolveConfiguredFilePlacement(localSettings, 'image', OTHER_WINDOW, DEFAULT_WINDOW),
		).toEqual({ type: 'window', windowId: OTHER_WINDOW });
		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', OTHER_WINDOW, DEFAULT_WINDOW),
		).toEqual({ type: 'dialog' });

		localSettings.destroy();
	});

	it('falls back to the default window when the origin is not a window', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', 'mobile', DEFAULT_WINDOW),
		).toEqual({ type: 'window', windowId: DEFAULT_WINDOW });
		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', 'dialog', DEFAULT_WINDOW),
		).toEqual({ type: 'window', windowId: DEFAULT_WINDOW });

		localSettings.destroy();
	});

	it('routes new-window file opens even when background view persistence rejects', async () => {
		localStorage.clear();
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.set('textEditorOpenPlacement', 'new-window');
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const persist = vi
			.spyOn(FileViewRecovery.prototype, 'persistView')
			.mockRejectedValue(new Error('View storage unavailable'));

		const opening = services.files.open({
			fileRootPath: '/workspace',
			relativePath: 'from-main.ts',
			mode: 'code',
			origin: 'window-main',
			reason: 'user-open',
		});
		await vi.waitFor(() => {
			const snapshot = services!.layout.snapshot;
			const fileSurface = Object.keys(snapshot.surfaces).find((id) => id.startsWith('file:'));
			expect(fileSurface).toBeDefined();
			const windowId = windowIdOfSurface(snapshot.desktopRoot, fileSurface!);
			expect(windowId).not.toBeNull();
			expect(windowId).not.toBe('window-main');
		});
		const snapshot = services.layout.snapshot;
		const placedSurfaceId = Object.keys(snapshot.surfaces).find((id) => id.startsWith('file:'))!;
		const windowId = windowIdOfSurface(snapshot.desktopRoot, placedSurfaceId)!;
		services.surfaceFrames.register(placedSurfaceId, windowId, {
			element: document.createElement('div'),
			attachRetainedRenderer: () => {},
			focusPrimary: () => {},
		});
		const opened = await opening;
		if (!opened) throw new Error('Expected file to open');
		expect(persist).toHaveBeenCalledWith(opened, 'window-main');
		const context = { viewId: opened.id, surfaceId: placedSurfaceId };
		expect(services.commands.isEnabled('editor.find', context)).toBe(false);
		expect(services.commands.isEnabled('unknown-command', context)).toBe(false);
		const sideCommand = services.commands
			.available(context)
			.find((command) => command.id === 'file.open-to-side');
		expect(sideCommand?.isEnabled(context)).toBe(true);
		const openToSide = vi.spyOn(services.files, 'openToSide').mockResolvedValue(null);
		expect(await services.commands.execute('file.open-to-side', context)).toBe(true);
		expect(openToSide).toHaveBeenCalledWith(opened.id, windowId);
		expect(sideCommand?.isEnabled({ viewId: opened.id, surfaceId: 'unplaced-dialog' })).toBe(false);
		openToSide.mockRestore();
		await vi.waitFor(() => {
			expect(windowNodeById(services!.layout.snapshot.desktopRoot, windowId)?.tabs.activeId).toBe(
				placedSurfaceId,
			);
		});
	});

	it('persists changed file placement without polling or writing for unrelated layout changes', async () => {
		localStorage.clear();
		const repository = draftRepositories.createMemoryFileDraftRepository();
		vi.spyOn(draftRepositories, 'createFileDraftRepository').mockReturnValue(repository);
		const putView = vi.spyOn(repository, 'putView');
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const workspace = services;
		workspace.hostGeometry.size = { width: 2000, height: 900 };
		await workspace.files.ready();
		const waitForFrame = workspace.surfaceFrames.waitFor.bind(workspace.surfaceFrames);
		vi.spyOn(workspace.surfaceFrames, 'waitFor').mockImplementation((expectation) => {
			const pending = waitForFrame(expectation);
			workspace.surfaceFrames.register(expectation.surfaceId, expectation.host, {
				element: document.createElement('div'),
				attachRetainedRenderer: () => {},
				focusPrimary: () => {},
			});
			return pending;
		});
		const opened = await workspace.files.open({
			fileRootPath: '/workspace',
			relativePath: 'layout.ts',
			mode: 'code',
			origin: 'window-main',
			reason: 'user-open',
		});
		if (!opened) throw new Error('Expected file to open');
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(250);
		putView.mockClear();
		const visibilityChanged = vi.spyOn(workspace.files, 'viewVisibilityChanged');

		const surfaceId = `file:${opened.id}`;
		await workspace.coordinator.moveTabToNewWindow(surfaceId, DEFAULT_WINDOW, 'right');
		const destination = windowIdOfSurface(workspace.layout.snapshot.desktopRoot, surfaceId);
		expect(destination).not.toBeNull();
		expect(destination).not.toBe(DEFAULT_WINDOW);
		await vi.advanceTimersByTimeAsync(100);
		const partition = workspace.layout.snapshot.desktopRoot;
		if (partition.type !== 'partition') throw new Error('Expected split workspace');
		await workspace.coordinator.setPartitionRatio(partition.id, 0.6);
		await vi.advanceTimersByTimeAsync(149);
		expect(putView).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(putView).toHaveBeenCalledOnce();
		expect(putView).toHaveBeenCalledWith(
			expect.objectContaining({ viewId: opened.id, placement: destination }),
		);
		await expect(
			repository.getViews('test-user', FILE_RECOVERY_DEPLOYMENT_ID, 'test-client'),
		).resolves.toEqual([expect.objectContaining({ viewId: opened.id, placement: destination })]);
		putView.mockClear();
		visibilityChanged.mockClear();
		await workspace.coordinator.setPartitionRatio(partition.id, 0.7);
		await vi.advanceTimersByTimeAsync(250);
		expect(putView).not.toHaveBeenCalled();
		expect(visibilityChanged).not.toHaveBeenCalled();
	});

	it('restores the browser-owned file window topology before file recovery', () => {
		rootLocalSettings = createLocalSettingsStore();
		const raw = JSON.stringify({
			version: 1,
			browserSessionId: 'test-client',
			root: {
				type: 'partition',
				id: 'partition-file-side',
				direction: 'horizontal',
				ratio: 0.63,
				children: [
					{
						type: 'window',
						id: 'window-main',
						order: [{ type: 'chat', chatId: null }],
						active: { type: 'chat', chatId: null },
						mru: [{ type: 'chat', chatId: null }],
					},
					{
						type: 'window',
						id: 'window-side',
						order: [{ type: 'file', viewId: 'restored-view' }],
						active: { type: 'file', viewId: 'restored-view' },
						mru: [{ type: 'file', viewId: 'restored-view' }],
					},
				],
			},
			unplacedTerminalIds: [],
		});

		({ services } = assembleWorkspaceServices(rootLocalSettings, raw));

		expect(services.layout.snapshot.desktopRoot).toMatchObject({
			type: 'partition',
			id: 'partition-file-side',
			ratio: 0.63,
		});
		expect(windowIdOfSurface(services.layout.snapshot.desktopRoot, 'file:restored-view')).toBe(
			'window-side',
		);
	});

	it('assembles the coordinator and keeps root-owned domain bindings reactive', async () => {
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.showQuickCommitTray = false;
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const { ghCapability } = assembled;
		await tick();

		expect(services.restore.source).toBe('absent');
		expect(services.coordinator.layout).toBe(services.layout);
		expect(
			windowNodeById(services.layout.snapshot.desktopRoot, DEFAULT_WINDOW)?.tabs.order[0],
		).toBe('chat-view:window-main');
		expect(services.workspaceInteractionGate).toBeDefined();
		expect(services.surfaceFrames).toBeDefined();
		expect(services.shortcuts).toBeDefined();
		const commandIds = services.commands.commands.map((command) => command.id);
		expect(new Set(commandIds).size).toBe(commandIds.length);
		for (const [, commandId] of FILE_SHORTCUT_COMMANDS) {
			expect(commandIds).toContain(commandId);
		}
		expect(services.singletonSurfaces.filesIfPresent()).toBeNull();
		expect(services.commands.knownFileLocations).toEqual([]);
		expect(services.singletonSurfaces.filesIfPresent()).toBeNull();
		expect(services.gitQuickSummary.isEnabled).toBe(false);
		expect(services.singletonSurfaces.pullRequests().capabilityState).toBe('available');

		rootLocalSettings.showQuickCommitTray = true;
		ghCapability.available = false;
		await tick();

		expect(services.gitQuickSummary.isEnabled).toBe(true);
		expect(services.singletonSurfaces.pullRequests().capabilityState).toBe('unavailable');
	});

	it('assembles before terminal identity is ready without secure-context-only randomUUID', () => {
		const unavailable = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
			throw new TypeError('crypto.randomUUID is unavailable');
		});
		try {
			rootLocalSettings = createLocalSettingsStore();
			({ services } = assembleWorkspaceServices(rootLocalSettings, null, null));
			expect(services.files).toBeDefined();
			expect(unavailable).not.toHaveBeenCalled();
		} finally {
			unavailable.mockRestore();
		}
	});

	it('does not resolve the selected project again for record-only chat updates', async () => {
		projectResolutionApiMocks.resolveProject.mockImplementation(async (target: ProjectTarget) => ({
			target,
			resolution: { kind: 'available' as const, effectiveProjectKey: target.projectPath },
		}));
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.showQuickCommitTray = false;
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const entry = makeChatEntry();
		assembled.chatSessions.upsertServerChat(entry);
		assembled.chatSessions.setSelectedChatId(entry.id);
		await vi.waitFor(() => expect(projectResolutionApiMocks.resolveProject).toHaveBeenCalledOnce());
		assembled.chatSessions.patchPreview(entry.id, 'Streaming preview');
		assembled.chatSessions.patchActivity(entry.id, '2026-09-06T00:00:01.000Z');
		assembled.chatSessions.applyProcessingEvent(entry.id, 'running');
		await tick();

		expect(projectResolutionApiMocks.resolveProject).toHaveBeenCalledOnce();
	});

	it('disposes retained project resolution when its chat is removed', async () => {
		let resolutionSignal: AbortSignal | undefined;
		projectResolutionApiMocks.resolveProject.mockImplementation(
			(_target: ProjectTarget, signal: AbortSignal) => {
				resolutionSignal = signal;
				return new Promise((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					);
				});
			},
		);
		rootLocalSettings = createLocalSettingsStore();
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const entry = makeChatEntry();
		assembled.chatSessions.upsertServerChat(entry);
		const lease = services.projectResolution.retain({
			kind: 'chat',
			chatId: entry.id,
			projectPath: entry.projectPath,
		});
		const resolution = lease.resolve();
		await vi.waitFor(() => expect(resolutionSignal).toBeDefined());

		assembled.chatSessions.removeChat(entry.id);
		expect(resolutionSignal?.aborted).toBe(true);
		await resolution;

		expect(lease.snapshot).toEqual({ kind: 'unchecked' });
		lease.release();
	});

	it('renews demanded resolution after an A/B/A binding change in one reactive flush', async () => {
		projectResolutionApiMocks.resolveProject.mockImplementation(async (target: ProjectTarget) => ({
			target,
			resolution: { kind: 'available' as const, effectiveProjectKey: target.projectPath },
		}));
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.showQuickCommitTray = true;
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const entry = makeChatEntry({ projectPath: '/workspace/a' });
		assembled.chatSessions.upsertServerChat(entry);
		assembled.chatSessions.setSelectedChatId(entry.id);
		await vi.waitFor(() => expect(projectResolutionApiMocks.resolveProject).toHaveBeenCalledOnce());

		assembled.chatSessions.patchChat(entry.id, { projectPath: '/workspace/b' });
		assembled.chatSessions.patchChat(entry.id, { projectPath: '/workspace/a' });

		await vi.waitFor(() =>
			expect(projectResolutionApiMocks.resolveProject).toHaveBeenCalledTimes(2),
		);
		expect(
			projectResolutionApiMocks.resolveProject.mock.calls.map(
				([requested]) => requested.projectPath,
			),
		).toEqual(['/workspace/a', '/workspace/a']);
	});

	it('keeps a resolved destination when an old binding requests a metadata refresh', async () => {
		const oldTarget = {
			kind: 'chat',
			chatId: '1788698026082000',
			projectPath: '/workspace/old-project',
		} as const;
		const destination = { ...oldTarget, projectPath: '/workspace/new-project' } as const;
		const oldResult = Promise.withResolvers<never>();
		projectResolutionApiMocks.resolveProject.mockImplementation(
			async (requested: ProjectTarget) => {
				if (requested.projectPath === oldTarget.projectPath) return oldResult.promise;
				return {
					target: requested,
					resolution: {
						kind: 'available' as const,
						effectiveProjectKey: '/real/new-project',
					},
				};
			},
		);
		rootLocalSettings = createLocalSettingsStore();
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		assembled.chatSessions.upsertServerChat(makeChatEntry({ projectPath: oldTarget.projectPath }));
		const refresh = vi
			.spyOn(assembled.chatSessions, 'quietRefreshChats')
			.mockResolvedValue(undefined);
		const oldLease = services.projectResolution.retain(oldTarget);
		const destinationLease = services.projectResolution.retain(destination);
		const oldPending = oldLease.resolve();
		await destinationLease.resolve();

		oldResult.reject(new ApiError(409, 'changed', 'PROJECT_PATH_CHANGED'));
		await oldPending;

		expect(oldLease.snapshot).toEqual({ kind: 'request-failed', message: 'changed' });
		expect(destinationLease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/new-project',
		});
		expect(refresh).toHaveBeenCalledOnce();
		oldLease.release();
		destinationLease.release();
	});

	it('skips binding refresh after the declared path has already changed', async () => {
		projectResolutionApiMocks.resolveProject.mockRejectedValue(
			new ApiError(409, 'changed', 'PROJECT_PATH_CHANGED'),
		);
		rootLocalSettings = createLocalSettingsStore();
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		assembled.chatSessions.upsertServerChat(makeChatEntry({ projectPath: '/workspace/new' }));
		const refresh = vi.spyOn(assembled.chatSessions, 'quietRefreshChats');
		const lease = services.projectResolution.retain({
			kind: 'chat',
			chatId: '1788698026082000',
			projectPath: '/workspace/old',
		});

		await lease.resolve();

		expect(refresh).not.toHaveBeenCalled();
		lease.release();
	});

	it('coalesces binding refreshes while reconciliation is pending', async () => {
		projectResolutionApiMocks.resolveProject.mockRejectedValue(
			new ApiError(409, 'changed', 'PROJECT_PATH_CHANGED'),
		);
		rootLocalSettings = createLocalSettingsStore();
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		assembled.chatSessions.upsertServerChat(makeChatEntry({ projectPath: '/workspace/project' }));
		const pendingRefresh = Promise.withResolvers<void>();
		const refresh = vi
			.spyOn(assembled.chatSessions, 'quietRefreshChats')
			.mockReturnValue(pendingRefresh.promise);
		const lease = services.projectResolution.retain({
			kind: 'chat',
			chatId: '1788698026082000',
			projectPath: '/workspace/project',
		});

		await lease.resolve();
		await lease.retry();

		expect(refresh).toHaveBeenCalledOnce();
		pendingRefresh.resolve();
		await pendingRefresh.promise;
		lease.release();
	});

	it('resolves partition bounds from the shared host measurement', async () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const hostWidth = 1200;
		services.hostGeometry.size = { width: hostWidth, height: 500 };
		await services.coordinator.openChatInNewWindow('chat-2');
		const root = services.layout.snapshot.desktopRoot;
		if (root.type !== 'partition') throw new Error('Expected partition root');
		const requiredWidth = MIN_WINDOW_WIDTH_PX + WORKSPACE_RESIZE_BOUND_SAFETY_PX;

		expect(services.coordinator.resolvePartitionRatioBounds(root.id)).toEqual({
			min: requiredWidth / (hostWidth * 0.5),
			max: 1 - requiredWidth / hostWidth,
			adjustable: true,
		});
	});

	it('cancels root-owned window drag before a main-inert transition', () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		services.windowDnd.beginChatDrag('chat-dragged');
		expect(services.windowDnd.isDragging).toBe(true);

		const element = document.createElement('div');
		document.body.append(element);
		let unregister: () => void = () => undefined;
		services.transientLayers.open('main-inert', () => {
			unregister = services!.transientLayers.register({
				id: 'test-dialog',
				kind: 'application-dialog',
				modality: 'main-inert',
				isOpen: () => true,
				element: () => element,
				onEscape: () => true,
				restoreFocus: () => undefined,
			});
		});

		expect(services.windowDnd.isDragging).toBe(false);
		unregister();
		element.remove();
	});
});
