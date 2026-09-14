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
import { windowNodeById } from '../window-tree.js';
import type { FileLocation } from '$lib/files/navigation/file-navigation-store.svelte.js';
import { FILE_SHORTCUT_COMMANDS } from '../workspace-shortcuts.js';
import { FileSession } from '$lib/files/sessions/__tests__/file-session-fixture.js';
import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
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
	clientId: string | null = 'test-client',
): {
	services: WorkspaceServices;
	ghCapability: ReturnType<typeof createGhCapabilityStore>;
	chatSessions: ReturnType<typeof createChatSessionsStore>;
	notifications: ReturnType<typeof createNotificationsStore>;
} {
	const notifications = createNotificationsStore();
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
		notifications,
		terminalIdentity: { clientId },
		ws,
		getRouteIdentity: () => '/',
		onTerminalLauncherDismissed: () => {},
		isTerminalLauncherDismissed: () => false,
		workspaceLayoutRaw: null,
	});
	if (clientId) void services.files.initializeRecovery('test-user');
	return { services, ghCapability, chatSessions, notifications };
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

	it.each(['known', 'back', 'forward'] as const)(
		'opens %s file locations in the command context window',
		async (action) => {
			rootLocalSettings = createLocalSettingsStore();
			({ services } = assembleWorkspaceServices(rootLocalSettings));
			await services.files.initializeRecovery('test-user');
			const location: FileLocation = {
				key: '["/workspace","first.md"]',
				canonicalFileRootPath: '/workspace',
				normalizedRelativePath: 'first.md',
				displayPath: 'first.md',
				revision: null,
				line: 1,
				column: 1,
				viewPreference: 'preview',
				timestamp: 1,
			};
			const context = { viewId: null, surfaceId: 'singleton:files' };
			const open = vi.spyOn(services.files, 'open').mockResolvedValue(null);
			if (action === 'known') {
				vi.spyOn(services.commands, 'context').mockReturnValue(context);
				await services.commands.openLocation(location);
			} else {
				const navigation = services.files.navigation!;
				navigation.record(location);
				navigation.record({
					...location,
					key: '["/workspace","second.md"]',
					normalizedRelativePath: 'second.md',
					displayPath: 'second.md',
				});
				if (action === 'forward') {
					navigation.back();
					navigation.completeNavigation(true);
				}
				await services.commands.execute(`file.navigate-${action}`, context);
			}
			expect(open).toHaveBeenCalledWith(expect.objectContaining({ origin: 'window-files' }));
		},
	);

	it.each([true, false])(
		'copies file locations through the clipboard fallback: %s',
		async (copied) => {
			rootLocalSettings = createLocalSettingsStore();
			const assembled = assembleWorkspaceServices(rootLocalSettings);
			services = assembled.services;
			const session = new FileSession(
				{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
				'command-copy',
			);
			vi.spyOn(services.files, 'get').mockReturnValue(session);
			vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined!);
			const descriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
			const copy = vi.fn(() => {
				expect((document.activeElement as HTMLTextAreaElement).value).toBe('file.ts:1:1');
				return copied;
			});
			Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
			try {
				await expect(
					services.commands.execute('file.copy-location', {
						viewId: session.id,
						surfaceId: `file:${session.id}`,
					}),
				).resolves.toBe(copied);
				expect(copy).toHaveBeenCalledWith('copy');
				expect(assembled.notifications.items.at(-1)).toMatchObject({
					tone: copied ? 'info' : 'error',
					message: copied ? 'Copied to clipboard' : 'Could not copy file location.',
				});
			} finally {
				if (descriptor) Object.defineProperty(document, 'execCommand', descriptor);
				else Reflect.deleteProperty(document, 'execCommand');
			}
		},
	);

	it('keeps the current file command port and reports chat append outcomes', async () => {
		rootLocalSettings = createLocalSettingsStore();
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const session = new FileSession(
			{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
			'command-chat',
		);
		vi.spyOn(services.files, 'get').mockReturnValue(session);
		const context = { viewId: session.id, surfaceId: `file:${session.id}` };
		const obsolete = vi.fn(() => 'unavailable' as const);
		const removeObsolete = services.commands.registerFileSurface(session.id, {
			appendToChatDraft: obsolete,
		});
		const append = vi.fn<import('$lib/chat/composer/chat-draft-append.js').ChatDraftAppend>(
			() => 'appended',
		);
		const removeCurrent = services.commands.registerFileSurface(session.id, {
			appendToChatDraft: append,
		});
		removeObsolete();
		expect(services.commands.isEnabled('file.send-to-chat', context)).toBe(true);
		await expect(services.commands.execute('file.send-to-chat', context)).resolves.toBe(true);
		expect(obsolete).not.toHaveBeenCalled();
		expect(append).toHaveBeenCalledWith('`file.ts`');
		expect(assembled.notifications.items.at(-1)?.message).toBe('Added to chat draft.');
		append.mockReturnValue('duplicate');
		await expect(services.commands.execute('file.send-to-chat', context)).resolves.toBe(true);
		expect(assembled.notifications.items.at(-1)?.message).toBe('Already in chat draft.');
		append.mockReturnValue('unavailable');
		await expect(services.commands.execute('file.send-to-chat', context)).resolves.toBe(false);
		expect(assembled.notifications.items.at(-1)).toMatchObject({
			tone: 'error',
			message: 'Open a chat composer first.',
		});
		expect(assembled.notifications.items.filter((item) => item.tone === 'info')).toHaveLength(1);
		removeCurrent();
		expect(services.commands.isEnabled('file.send-to-chat', context)).toBe(false);
	});

	it('disables history commands at boundaries and while opening a target', async () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		await services.files.initializeRecovery('test-user');
		const navigation = services.files.navigation!;
		expect(services.commands.isEnabled('file.navigate-back')).toBe(false);
		expect(services.commands.isEnabled('file.navigate-forward')).toBe(false);
		const location: FileLocation = {
			key: 'first',
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: 'first.ts',
			displayPath: 'first.ts',
			revision: null,
			line: 1,
			column: 1,
			viewPreference: 'source',
			timestamp: 0,
		};
		navigation.record(location);
		navigation.record({ ...location, key: 'second', normalizedRelativePath: 'second.ts' });
		const opened = Promise.withResolvers<null>();
		vi.spyOn(services.files, 'open').mockReturnValue(opened.promise);
		expect(services.commands.isEnabled('file.navigate-back')).toBe(true);
		const pending = services.commands.execute('file.navigate-back');
		expect(services.commands.isEnabled('file.navigate-back')).toBe(false);
		expect(services.commands.isEnabled('file.navigate-forward')).toBe(false);
		opened.resolve(null);
		await pending;
		expect(services.commands.isEnabled('file.navigate-back')).toBe(true);
	});

	it('queues Reveal after the Files surface opens even before its tree is ready', async () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const session = new FileSession(
			{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
			'command-reveal',
		);
		vi.spyOn(services.files, 'get').mockReturnValue(session);
		const attached = Promise.withResolvers<void>();
		vi.spyOn(services.coordinator, 'openSingleton').mockReturnValue(attached.promise);
		const controller = services.singletonSurfaces.files();
		const reveal = vi.spyOn(controller, 'revealFile');
		const pending = services.commands.execute('file.reveal-active', {
			viewId: session.id,
			surfaceId: `file:${session.id}`,
		});
		expect(reveal).not.toHaveBeenCalled();
		attached.resolve();
		await pending;
		expect(controller.tree.readyResponse).toBeNull();
		expect(reveal).toHaveBeenCalledWith('/workspace', 'file.ts');
	});

	it('opens a side view from the command context window', async () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const session = new FileSession(
			{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
			'command-side',
		);
		vi.spyOn(services.files, 'get').mockReturnValue(session);
		const open = vi.spyOn(services.files, 'openToSide').mockResolvedValue(null);
		await expect(
			services.commands.execute('file.open-to-side', {
				viewId: session.id,
				surfaceId: 'singleton:files',
			}),
		).resolves.toBe(true);
		expect(open).toHaveBeenCalledWith(session.id, 'window-files');
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
			{ saving: true },
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
			for (const saving of [false, true]) {
				session.document.saving = saving;
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
			({ services } = assembleWorkspaceServices(rootLocalSettings, null));
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
