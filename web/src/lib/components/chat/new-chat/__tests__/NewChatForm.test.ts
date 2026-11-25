import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { loadComposerMarkdownEditor } from '../../composer/composer-markdown-editor-loader.js';
import NewChatFormTestHost from './NewChatFormTestHost.svelte';
import * as settingsApi from '$lib/api/settings';
import * as gitApi from '$lib/api/git';
import * as filesApi from '$lib/api/files';
import { ApiError } from '$lib/api/client';
import { validateStart, type ValidateStartResponse } from '$lib/api/chats';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as snippetsApi from '$lib/api/snippets';
import * as clientChatId from '$shared/client-chat-id';
import * as preamblesApi from '$lib/api/chat-preambles';
import type { PreambleSelectionPreviewResponse } from '$lib/api/chat-preambles';
import { parseChatId } from '$shared/chat-id';
import { DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID } from '$shared/agents';
import type { PreamblesSnapshot } from '$shared/preambles';
import type { WsConnectionPhase } from '$lib/ws/connection.svelte.js';
import { localExecutor, remoteExecutor, localScope } from '$lib/executors/__tests__/fixtures';
import { ModelCatalogStore, type ModelOption } from '$lib/agents/model-catalog-store.svelte';
import { nativeCatalogAgent } from '../../../../../test/model-catalog';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';

vi.mock('../../composer/composer-markdown-editor-loader.js', () => ({
	loadComposerMarkdownEditor: vi.fn(() => new Promise(() => {})),
}));

const PROSPECTIVE_CHAT_ID = parseChatId('1787471053739199');
const RESEEDED_CHAT_ID = parseChatId('1787471053739200');
const validate = vi.mocked(validateStart);

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn(),
}));

vi.mock('$lib/api/chat-preambles', () => ({
	preambleSelectionPreview: vi.fn(async (request: { projectPath: string }) => ({
		success: true,
		canonicalProjectPath: request.projectPath,
		orderedPreambleIds: [],
		projection: { catalogRevision: 0, eligiblePreambles: [], unavailable: [] },
	})),
}));

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
}));

vi.mock('$lib/api/files', () => ({
	browseDirectory: vi.fn(async () => []),
	createDirectory: vi.fn(),
}));

vi.mock('$lib/api/settings', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

vi.mock('$lib/api/snippets', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/snippets')>();
	return { ...actual, expandSnippet: vi.fn() };
});

vi.mock('$shared/client-chat-id', () => ({
	createClientChatId: vi.fn(() => '1787471053739199'),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

type SnapshotOverrides = Partial<Omit<RemoteSettingsSnapshot, 'paths' | 'executionDefaults'>> & {
	paths?: Partial<RemoteSettingsSnapshot['paths']>;
	executionDefaults?: {
		global?: Partial<RemoteSettingsSnapshot['executionDefaults']['global']>;
		byAgent?: RemoteSettingsSnapshot['executionDefaults']['byAgent'];
	};
};

function makeSnapshot(overrides: SnapshotOverrides = {}): RemoteSettingsSnapshot {
	const snapshot: RemoteSettingsSnapshot = {
		version: 1,
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true, tickets: true },
		},
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [
			{
				agentId: 'claude',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettingsById: {},
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
	};
	return {
		...snapshot,
		...overrides,
		paths: {
			...snapshot.paths,
			...(overrides.paths ?? {}),
		},
		executionDefaults: {
			global: {
				...snapshot.executionDefaults.global,
				...(overrides.executionDefaults?.global ?? {}),
			},
			byAgent: {
				...snapshot.executionDefaults.byAgent,
				...(overrides.executionDefaults?.byAgent ?? {}),
			},
		},
	};
}

function stubMatchMedia(matches: boolean): void {
	vi.stubGlobal(
		'matchMedia',
		vi.fn().mockImplementation(() => ({
			matches,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	);
}

async function renderSubmittableForm(
	onStartChat: () => void,
	props: {
		executionPolicy?: 'conversation' | 'literal';
		supportsImages?: boolean;
		snippetTrigger?: string;
		snippetTemplate?: string;
		snippetDefaultArguments?: string;
		preloadSnippets?: boolean;
		wsPhase?: WsConnectionPhase;
		preambleSnapshot?: PreamblesSnapshot;
	} = {},
): Promise<HTMLTextAreaElement> {
	validate.mockResolvedValue({ valid: true, isGitRepo: false });
	vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
		makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
	);

	render(NewChatFormTestHost, { props: { ...props, onStartChat } });

	await waitFor(() => {
		expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
	});

	const messageInput = screen.getByPlaceholderText(
		'How can I help you today?',
	) as HTMLTextAreaElement;
	await fireEvent.input(messageInput, { target: { value: 'first line' } });

	// Wait for the seeded path to validate so the submit gate opens.
	await waitFor(() => {
		const submit = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
	});

	return messageInput;
}

async function inputAtCaret(
	textarea: HTMLTextAreaElement,
	value: string,
	caret: number,
	eventInit: InputEventInit = {},
): Promise<void> {
	textarea.value = value;
	textarea.setSelectionRange(caret, caret);
	await fireEvent.input(textarea, eventInit);
}

function previewResponse(
	catalogRevision: number,
	id: string,
	title: string,
): PreambleSelectionPreviewResponse {
	return {
		success: true,
		canonicalProjectPath: '/workspace/project',
		orderedPreambleIds: [id],
		projection: {
			catalogRevision,
			eligiblePreambles: [{ id, title }],
			unavailable: [],
		},
	};
}

function setAntigravityModels(catalog: ModelCatalogStore, models: ModelOption[]): void {
	catalog.agentMetadata = { antigravity: nativeCatalogAgent('antigravity', models) };
	catalog.agentModels = { antigravity: models };
	catalog.lastValidatedAt = Date.now();
}

describe('NewChatForm', () => {
	it.each([localExecutor, remoteExecutor])(
		'submits a project-only seed on $id with the retained prompt',
		async (executor) => {
			stubMatchMedia(false);
			validate.mockResolvedValue({ valid: true, isGitRepo: false });
			vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot());
			const onStartChat = vi.fn();
			render(NewChatFormTestHost, {
				onStartChat,
				executorSnapshots: [localExecutor, remoteExecutor],
				seed: {
					prefill: 'Synthetic project prompt',
					project: { executorId: executor.id, projectPath: '/workspace/selected' },
				},
			});
			await waitFor(() =>
				expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull(),
			);
			expect(screen.getByRole('textbox', { name: 'Project Path' })).toHaveProperty(
				'value',
				'/workspace/selected',
			);
			expect(screen.getByPlaceholderText('How can I help you today?')).toHaveProperty(
				'value',
				'Synthetic project prompt',
			);
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty(
					'disabled',
					false,
				),
			);
			await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
			expect(onStartChat).toHaveBeenCalledWith(
				expect.objectContaining({
					executorId: executor.id,
					projectPath: '/workspace/selected',
					firstMessage: 'Synthetic project prompt',
				}),
				PROSPECTIVE_CHAT_ID,
			);
		},
	);

	it('explains why a copied direct agent cannot start when direct chats are disabled', async () => {
		stubMatchMedia(false);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot());
		const onStartChat = vi.fn();
		render(NewChatFormTestHost, { allowDirectChats: false, onStartChat, seed: {
			prefill: 'Synthetic scheduled prompt',
			startup: { executorId: 'local', agentId: 'direct-openai-compatible', projectPath: '/workspace/project',
				model: 'chat-model', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
				permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {}, tags: [],
				preambleChoice: { mode: 'defaults' } },
		} });
		await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull());
		expect(await screen.findByText('The selected agent is not available for new chats.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty('disabled', true);
		await fireEvent.keyDown(screen.getByPlaceholderText('How can I help you today?'), { key: 'Enter', ctrlKey: true });
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('connects the formatted New Chat input to the shared Markdown editor', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot());
		render(NewChatFormTestHost, { composerInputMode: 'formatted' });
		await waitFor(() => expect(loadComposerMarkdownEditor).toHaveBeenCalled());
	});

	it.each([
		['source', 'conversation'],
		['formatted', 'literal'],
	] as const)('keeps %s / %s input in the source editor', async (composerInputMode, executionPolicy) => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot());
		render(NewChatFormTestHost, { composerInputMode, executionPolicy });
		await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull());
		expect(loadComposerMarkdownEditor).not.toHaveBeenCalled();
	});

	it('retains cached selection and text while catalog failure blocks click and Enter until retry', async () => {
		stubMatchMedia(false);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }));
		const onStartChat = vi.fn();
		const onRetryCatalog = vi.fn(async () => {});
		const view = render(NewChatFormTestHost, { onStartChat, onRetryCatalog });
		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const input = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(input, { target: { value: 'Synthetic cached-catalog prompt' } });
		const submit = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		await waitFor(() => expect(submit.disabled).toBe(false));

		await view.rerender({ catalogValidated: false });
		expect(screen.getByText('Loading models...')).toBeTruthy();
		expect(submit.disabled).toBe(true);
		await view.rerender({ catalogValidated: false, catalogError: 'Synthetic catalog failure' });
		expect(screen.getByText('Synthetic catalog failure')).toBeTruthy();
		await fireEvent.click(submit);
		expect(await fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
		expect((input as HTMLTextAreaElement).value).toBe('Synthetic cached-catalog prompt');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(onRetryCatalog).toHaveBeenCalledOnce();

		await view.rerender({ catalogValidated: true, catalogError: null });
		await waitFor(() => expect(submit.disabled).toBe(false));
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ firstMessage: 'Synthetic cached-catalog prompt' }), PROSPECTIVE_CHAT_ID);
	});

	afterEach(() => {
		localStorage.clear();
		vi.unstubAllGlobals();
		vi.mocked(filesApi.browseDirectory).mockReset().mockResolvedValue([]);
		vi.mocked(filesApi.createDirectory).mockReset();
		vi.mocked(snippetsApi.expandSnippet).mockReset();
		vi.mocked(clientChatId.createClientChatId).mockReset();
		vi.mocked(clientChatId.createClientChatId).mockReturnValue(PROSPECTIVE_CHAT_ID);
		vi.mocked(preamblesApi.preambleSelectionPreview).mockReset();
		vi.mocked(preamblesApi.preambleSelectionPreview).mockImplementation(async (request) => ({
			success: true,
			canonicalProjectPath: request.projectPath,
			orderedPreambleIds: request.orderedPreambleIds ?? [],
			projection: { catalogRevision: 0, eligiblePreambles: [], unavailable: [] },
		}));
	});

	it('retains explicit helpers and submits literal slash source unchanged', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const input = await renderSubmittableForm(onStartChat, { executionPolicy: 'literal' });
		expect(screen.queryByRole('button', { name: 'Edit preambles' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Refine prompt' })).toBeTruthy();
		const firstMessage = '/snippet untouched\n  ';
		await fireEvent.input(input, { target: { value: firstMessage } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ firstMessage }), PROSPECTIVE_CHAT_ID);
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
	});

	it('reveals the form after settings and loads preamble data independently', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		const validation = deferred<ValidateStartResponse>();
		validate.mockReturnValue(validation.promise);
		const catalog = deferred<PreamblesSnapshot>();
		const preview = deferred<PreambleSelectionPreviewResponse>();
		const loadPreambles = vi.fn(() => catalog.promise);
		vi.mocked(preamblesApi.preambleSelectionPreview).mockReturnValueOnce(preview.promise);

		render(NewChatFormTestHost, {
			props: {
				preambleSnapshot: null,
				loadPreambles,
			},
		});

		const content = document.querySelector<HTMLElement>('[data-slot="new-chat-form-content"]')!;
		await waitFor(() => {
			expect(content.classList.contains('invisible')).toBe(false);
			expect(content.hasAttribute('inert')).toBe(false);
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		expect(screen.getByText('Fetching preambles…')).toBeTruthy();
		expect(loadPreambles).not.toHaveBeenCalled();
		expect(preamblesApi.preambleSelectionPreview).not.toHaveBeenCalled();

		await waitFor(() => expect(validate).toHaveBeenCalledOnce());
		validation.resolve({ valid: true, isGitRepo: false });
		await waitFor(() => expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledOnce());
		expect(content.classList.contains('invisible')).toBe(false);
		preview.resolve({
			success: true,
			canonicalProjectPath: '/workspace/project',
			orderedPreambleIds: [],
			projection: { catalogRevision: 1, eligiblePreambles: [], unavailable: [] },
		});
		expect(await screen.findByText('No preambles will be applied')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Edit preambles' }));
		await waitFor(() => expect(loadPreambles).toHaveBeenCalledOnce());
		expect(screen.getByText('Loading preambles...')).toBeTruthy();
		catalog.resolve({ revision: 1, preambles: [] });
		await waitFor(() => expect(screen.queryByText('Loading preambles...')).toBeNull());
		expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledOnce();
		expect(screen.getByText('No preambles will be applied')).toBeTruthy();
	});

	it('refreshes previews when the catalog is newer and after later revisions', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(preamblesApi.preambleSelectionPreview)
			.mockResolvedValueOnce(previewResponse(1, '3502b645-222b-49d2-ac39-1c91f9fb1174', 'First'))
			.mockResolvedValueOnce(previewResponse(2, 'e767feba-8cbf-4ec4-9b16-f907bcb40836', 'Second'))
			.mockResolvedValueOnce(previewResponse(3, 'fe5ff036-59fc-40ad-86ab-e069f96713c8', 'Third'));
		let preambles!: PreamblesStore;

		render(NewChatFormTestHost, {
			props: {
				preambleSnapshot: null,
				onPreambles: (store) => (preambles = store),
			},
		});

		expect(await screen.findByText('First')).toBeTruthy();
		preambles.applySnapshot({ revision: 2, preambles: [] });
		expect(await screen.findByText('Second')).toBeTruthy();
		expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledTimes(2);

		preambles.applySnapshot({ revision: 3, preambles: [] });
		expect(await screen.findByText('Third')).toBeTruthy();
		expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledTimes(3);
	});

	it('refreshes a stale preview that resolves after the catalog loads', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		const firstPreview = deferred<PreambleSelectionPreviewResponse>();
		vi.mocked(preamblesApi.preambleSelectionPreview)
			.mockReturnValueOnce(firstPreview.promise)
			.mockResolvedValueOnce(previewResponse(2, 'e767feba-8cbf-4ec4-9b16-f907bcb40836', 'Current'));
		let preambles!: PreamblesStore;

		render(NewChatFormTestHost, {
			props: {
				preambleSnapshot: null,
				onPreambles: (store) => (preambles = store),
			},
		});

		await waitFor(() => expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledOnce());
		preambles.applySnapshot({ revision: 2, preambles: [] });
		firstPreview.resolve(previewResponse(1, '3502b645-222b-49d2-ac39-1c91f9fb1174', 'Stale'));

		expect(await screen.findByText('Current')).toBeTruthy();
		expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledTimes(2);
	});

	it('refreshes the preview after an invalidation without loading the catalog', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		const firstId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
		const secondId = 'e767feba-8cbf-4ec4-9b16-f907bcb40836';
		vi.mocked(preamblesApi.preambleSelectionPreview)
			.mockResolvedValueOnce(previewResponse(1, firstId, 'First'))
			.mockResolvedValueOnce(previewResponse(2, secondId, 'Second'));
		const loadPreambles = vi.fn();
		let preambles!: PreamblesStore;

		render(NewChatFormTestHost, {
			props: {
				preambleSnapshot: null,
				loadPreambles,
				onPreambles: (store) => (preambles = store),
			},
		});

		expect(await screen.findByText('First')).toBeTruthy();
		await preambles.refreshIfLoaded();
		expect(await screen.findByText('Second')).toBeTruthy();
		expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledTimes(2);
		expect(loadPreambles).not.toHaveBeenCalled();
	});

	it.each([
		{ isMobile: false, executor: localExecutor },
		{ isMobile: true, executor: localExecutor },
		{ isMobile: false, executor: remoteExecutor },
		{ isMobile: true, executor: remoteExecutor },
	])('revalidates the same path after creating its directory ($executor.kind, mobile: $isMobile)', async ({ isMobile, executor }) => {
		stubMatchMedia(isMobile);
		const projectPath = `${executor.projectBasePath}/fresh`;
		let created = false;
		validate.mockImplementation(async (path) =>
			path === projectPath && !created
				? { valid: false, errorCode: 'path_not_found' }
				: { valid: true, isGitRepo: false },
		);
		vi.mocked(filesApi.browseDirectory).mockImplementation(async (path) => {
			if (path === projectPath && !created) {
				throw new ApiError(404, 'File or directory not found', 'FILE_NOT_FOUND');
			}
			return [];
		});
		vi.mocked(filesApi.createDirectory).mockImplementation(async () => {
			created = true;
			return { name: 'fresh', path: projectPath, type: 'directory' };
		});
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot({
			paths: { recentProjectPaths: ['/workspace'], byExecutor: {} },
			recentAgentSettings: [{
				agentId: 'claude', model: 'opus', executorId: executor.id,
				apiProviderId: null, modelEndpointId: null, modelProtocol: null,
			}],
		}));
		const onStartChat = vi.fn();
		render(NewChatFormTestHost, {
			onStartChat,
			executorSnapshots: [localExecutor, {
				...remoteExecutor, executorServices: localExecutor.executorServices,
			}],
		});
		await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull());
		const pathInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Project Path' });
		await fireEvent.input(pathInput, { target: { value: projectPath } });
		await screen.findByText('Path does not exist.');
		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(messageInput, { target: { value: 'Synthetic first message' } });
		const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Start session' });
		expect(submit.disabled).toBe(true);
		await fireEvent.focus(pathInput);
		await fireEvent.click(await screen.findByRole('button', { name: 'Create directory "fresh"' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		await waitFor(() => expect(filesApi.createDirectory).toHaveBeenCalledExactlyOnceWith({
			executorId: executor.id, parentPath: executor.projectBasePath, name: 'fresh',
		}));
		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Directory name' })).toBeNull());
		if (isMobile) await fireEvent.click(screen.getByRole('button', { name: 'Select this directory' }));
		expect(pathInput.value).toBe(projectPath);
		await waitFor(() => expect(submit.disabled).toBe(false));
		expect(screen.queryByText('Path does not exist.')).toBeNull();
		expect(validate).toHaveBeenLastCalledWith(projectPath, { executorId: executor.id });
		if (isMobile) await fireEvent.click(submit);
		else await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			executorId: executor.id, projectPath, firstMessage: 'Synthetic first message',
		}), PROSPECTIVE_CHAT_ID);
	});

	it('reveals the replacement form after reopening while the current path is invalid', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		validate
			.mockResolvedValue({
				valid: false,
				error: 'Path does not exist',
				errorCode: 'path_not_found',
			})
			.mockResolvedValueOnce({ valid: true, isGitRepo: false });

		render(NewChatFormTestHost);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		await waitFor(() => expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledOnce());
		const pathInput = screen.getByRole('textbox', { name: 'Project Path' });
		await fireEvent.input(pathInput, { target: { value: '/workspace/missing' } });
		await screen.findByText('Path does not exist.');
		expect(await screen.findByText('Preambles unavailable')).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();

		const reseedButton = screen.getByTestId('reseed-new-chat');
		reseedButton.focus();
		await fireEvent.click(reseedButton);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
			const content = document.querySelector<HTMLElement>('[data-slot="new-chat-form-content"]')!;
			expect(content.classList.contains('invisible')).toBe(false);
		});
		expect(document.activeElement).toBe(screen.getByPlaceholderText('How can I help you today?'));
	});

	it('summarizes eligible preambles with responsive overflow counts', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		const projectedPreambles = [
			{
				id: '3502b645-222b-49d2-ac39-1c91f9fb1174',
				title: 'Repository conventions for exceptionally narrow workspaces',
			},
			{ id: 'e767feba-8cbf-4ec4-9b16-f907bcb40836', title: 'Review checklist' },
			{ id: 'fe5ff036-59fc-40ad-86ab-e069f96713c8', title: 'Security constraints' },
			{ id: 'd6ca191b-1f76-43df-982b-1f2487df7346', title: 'Coding conventions' },
			{ id: 'e6792ec7-b484-420c-bf7b-b4d202b216a5', title: 'Release requirements' },
		] as const;
		vi.mocked(preamblesApi.preambleSelectionPreview).mockResolvedValue({
			success: true,
			canonicalProjectPath: '/workspace/project',
			orderedPreambleIds: projectedPreambles.map((preamble) => preamble.id),
			projection: {
				catalogRevision: 1,
				eligiblePreambles: [...projectedPreambles],
				unavailable: [],
			},
		});

		render(NewChatFormTestHost);

		expect(
			await screen.findByText('Repository conventions for exceptionally narrow workspaces'),
		).toBeTruthy();
		expect(screen.getByText('Review checklist')).toBeTruthy();
		expect(screen.queryByText('Security constraints')).toBeNull();
		const label = document.querySelector<HTMLElement>('[data-slot="new-chat-preambles-label"]');
		const pills = document.querySelectorAll<HTMLElement>('[data-slot="new-chat-preamble-pill"]');
		const narrowOverflow = document.querySelector<HTMLElement>(
			'[data-slot="new-chat-preambles-overflow-narrow"]',
		);
		const wideOverflow = document.querySelector<HTMLElement>(
			'[data-slot="new-chat-preambles-overflow-wide"]',
		);
		expect(label?.textContent?.trim()).toBe('Preambles');
		expect(pills).toHaveLength(2);
		expect(narrowOverflow?.textContent?.trim()).toBe('and 4 more');
		expect(wideOverflow?.textContent?.trim()).toBe('and 3 more');
	});

	it('clears all preambles immediately without submitting the form', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		const preambleId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
		const clearedPreview = deferred<PreambleSelectionPreviewResponse>();
		vi.mocked(preamblesApi.preambleSelectionPreview)
			.mockResolvedValueOnce(previewResponse(1, preambleId, 'Repository conventions'))
			.mockReturnValueOnce(clearedPreview.promise);
		const onStartChat = vi.fn();

		render(NewChatFormTestHost, { props: { onStartChat } });

		expect(await screen.findByText('Repository conventions')).toBeTruthy();
		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(messageInput, { target: { value: 'Start without preambles' } });
		const start = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		await waitFor(() => expect(start.disabled).toBe(false));
		const edit = screen.getByRole('button', { name: 'Edit preambles' });
		const clear = screen.getByRole('button', { name: 'Clear preambles' }) as HTMLButtonElement;
		expect(clear.type).toBe('button');
		expect(edit.nextElementSibling).toBe(clear);

		await fireEvent.click(clear);

		expect(onStartChat).not.toHaveBeenCalled();
		await waitFor(() => expect(preamblesApi.preambleSelectionPreview).toHaveBeenCalledTimes(2));
		expect(preamblesApi.preambleSelectionPreview).toHaveBeenLastCalledWith(
			expect.objectContaining({ orderedPreambleIds: [] }),
		);
		await fireEvent.click(start);
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ orderedPreambleIds: [] }),
			PROSPECTIVE_CHAT_ID,
		);

		clearedPreview.resolve({
			success: true,
			canonicalProjectPath: '/workspace/project',
			orderedPreambleIds: [],
			projection: { catalogRevision: 1, eligiblePreambles: [], unavailable: [] },
		});
		expect(await screen.findByText('No preambles will be applied')).toBeTruthy();
	});

	it('retries a failed automatic preamble preview without opening the picker', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		const preambleId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
		vi.mocked(preamblesApi.preambleSelectionPreview)
			.mockRejectedValueOnce(new Error('preview unavailable'))
			.mockResolvedValueOnce({
				success: true,
				canonicalProjectPath: '/workspace/project',
				orderedPreambleIds: [preambleId],
				projection: {
					catalogRevision: 1,
					eligiblePreambles: [{ id: preambleId, title: 'Recovered default' }],
					unavailable: [],
				},
			});

		render(NewChatFormTestHost);

		expect((await screen.findByRole('alert')).textContent?.trim()).toBe('Preambles unavailable');
		const retry = screen.getByRole('button', { name: 'Refresh' });
		const edit = screen.getByRole('button', { name: 'Edit preambles' }) as HTMLButtonElement;
		expect(edit.disabled).toBe(true);

		await fireEvent.click(retry);

		expect(await screen.findByText('Recovered default')).toBeTruthy();
		expect(edit.disabled).toBe(false);
		expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
	});

	it('keeps path focus after the initial prompt focus has been delivered', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot());
		vi.useFakeTimers();
		try {
			render(NewChatFormTestHost);
			await vi.advanceTimersByTimeAsync(0);
			const prompt = screen.getByPlaceholderText('How can I help you today?');
			expect(document.activeElement).toBe(prompt);
			const path = screen.getByRole('textbox', { name: 'Project Path' });
			path.focus();
			await vi.advanceTimersByTimeAsync(50);
			expect(document.activeElement).toBe(path);
		} finally {
			cleanup();
			vi.useRealTimers();
		}
	});

	it('does not submit on Enter on mobile (Enter inserts a newline)', async () => {
		stubMatchMedia(true);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);

		// fireEvent returns false when the handler called preventDefault. On mobile
		// Enter must fall through to the textarea so a newline is inserted.
		const notPrevented = await fireEvent.keyDown(messageInput, { key: 'Enter' });

		expect(onStartChat).not.toHaveBeenCalled();
		expect(notPrevented).toBe(true);
	});

	it('submits on Enter on desktop', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);

		await fireEvent.keyDown(messageInput, { key: 'Enter' });

		expect(onStartChat).toHaveBeenCalledTimes(1);
		expect(onStartChat.mock.calls[0]?.[1]).toBe(PROSPECTIVE_CHAT_ID);
	});

	it('blocks click and Enter after the selected endpoint disappears', async () => {
		stubMatchMedia(false);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				recentAgentSettings: [
					{
						agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
						model: 'chat-model',
						apiProviderId: 'test-provider',
						modelEndpointId: 'test_openai',
						modelProtocol: 'openai-compatible',
					},
				],
			}),
		);
		const onStartChat = vi.fn();
		const view = render(NewChatFormTestHost, {
			props: {
				allowDirectChats: true,
				endpointBackedDirectModel: true,
				modelsAvailable: true,
				onStartChat,
			},
		});

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(messageInput, { target: { value: 'first line' } });
		await waitFor(() => {
			expect(
				(screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
			).toBe(false);
		});

		await view.rerender({ catalogVersion: 1, modelsAvailable: false });

		const submit = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		await waitFor(() => {
			expect(screen.getByText('Model unavailable')).toBeTruthy();
			expect(submit.disabled).toBe(true);
		});
		await fireEvent.click(submit);
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('shows a centered spinner and hides the composer until settings load', async () => {
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.getRemoteSettings>>>();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValueOnce(pending.promise);

		const { container } = render(NewChatFormTestHost);

		const projectPathInput = screen.getByLabelText('Project Path');
		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		const hiddenFormContainer = container.querySelector(
			'[data-slot="new-chat-form-content"][aria-hidden="true"]',
		);

		expect(screen.getByRole('status', { name: 'Loading chat defaults...' })).toBeTruthy();
		expect(hiddenFormContainer).toBeTruthy();
		expect(hiddenFormContainer?.contains(projectPathInput)).toBe(true);
		expect(hiddenFormContainer?.contains(messageInput)).toBe(true);

		pending.resolve(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
			}),
		);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		expect(
			container.querySelector('[data-slot="new-chat-form-content"][aria-hidden="true"]'),
		).toBeNull();
		expect(
			container
				.querySelector('[data-slot="new-chat-form-content"][aria-hidden="false"]')
				?.contains(projectPathInput),
		).toBe(true);
		expect(
			container
				.querySelector('[data-slot="new-chat-form-content"][aria-hidden="false"]')
				?.contains(messageInput),
		).toBe(true);
	});

	it('does not add bottom padding outside the shared composer bar', () => {
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.getRemoteSettings>>>();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValueOnce(pending.promise);

		render(NewChatFormTestHost);

		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		expect(messageInput.parentElement?.className).not.toContain('pb-1.5');
	});

	it('renders agent thinking as a toolbar button instead of a combobox', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);

		render(NewChatFormTestHost);

		const thinkingButton = await screen.findByRole('button', { name: 'Thinking: Auto' });
		expect(screen.queryByRole('combobox', { name: 'Thinking' })).toBeNull();
		expect(thinkingButton.closest('[data-slot="composer-bottom-bar"]')).toBeTruthy();

		await fireEvent.click(thinkingButton);
		const options = await screen.findAllByRole('menuitemradio');
		expect(options.map((option) => option.querySelector('.font-medium')?.textContent)).toEqual([
			'Auto',
			'On',
			'Off',
		]);
		expect(screen.getByText('Lets Claude decide when extended thinking is useful.')).toBeTruthy();
		expect(screen.getByText('Uses extended thinking for every response.')).toBeTruthy();
		expect(screen.getByText('Answers without extended thinking.')).toBeTruthy();
		await fireEvent.click(screen.getByRole('menuitemradio', { name: /^On/ }));
		expect(screen.getByRole('button', { name: 'Thinking: On' })).toBeTruthy();
	});

	it('lets a pin start drafting immediately without admitting a pending or invalid path', async () => {
		stubMatchMedia(false);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot({
			paths: { recentProjectPaths: ['/workspace/project'], pinnedProjectPaths: ['/workspace/other'] },
		}));
		const onStartChat = vi.fn();
		render(NewChatFormTestHost, { onStartChat });
		const prompt = await screen.findByPlaceholderText('How can I help you today?');
		await fireEvent.input(prompt, { target: { value: 'Synthetic first message' } });
		const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Start session' });
		await waitFor(() => expect(send.disabled).toBe(false));
		const validation = deferred<ValidateStartResponse>();
		validate.mockReturnValue(validation.promise);
		const pin = screen.getByRole('button', { name: '/workspace/other' });
		pin.focus();
		await fireEvent.click(pin);
		expect(pin.getAttribute('aria-pressed')).toBe('true');
		expect(document.activeElement).toBe(prompt);
		const expectSubmitBlocked = async () => {
			expect(send.disabled).toBe(true);
			await fireEvent.click(send);
			await fireEvent.keyDown(prompt, { key: 'Enter' });
			expect(onStartChat).not.toHaveBeenCalled();
		};
		await expectSubmitBlocked();
		validation.resolve({ valid: false, errorCode: 'path_not_found' });
		await screen.findByText('Path does not exist.');
		await expectSubmitBlocked();
		expect(document.activeElement).toBe(prompt);
	});

	it('does not treat a focused pin as a selection when executor discovery revalidates the path', async () => {
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot({
			paths: { recentProjectPaths: ['/workspace/project'], pinnedProjectPaths: ['/workspace/other'] },
		}));
		let executors!: ExecutorsStore;
		render(NewChatFormTestHost, { onExecutors: (store) => { executors = store; } });
		const marker = '[data-slot="project-path-field"] .text-status-success-foreground';
		await waitFor(() => expect(document.querySelector(marker)).toBeTruthy());
		const pin = screen.getByRole('button', { name: '/workspace/other' });
		const validation = deferred<ValidateStartResponse>();
		validate.mockClear().mockReturnValue(validation.promise);
		pin.focus();
		executors.applySnapshot([{ ...localExecutor, instanceId: 'discovered-instance' }]);
		await waitFor(() => expect(validate).toHaveBeenCalledWith('/workspace/project', { executorId: 'local' }));
		validation.resolve({ valid: true, isGitRepo: false });
		await waitFor(() => expect(document.querySelector(marker)).toBeTruthy());
		expect(document.activeElement).toBe(pin);
	});

	it('shows a spinner while pinned project path persistence is pending', async () => {
		stubMatchMedia(false);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.updateRemoteSettings>>>();
		vi.mocked(settingsApi.updateRemoteSettings).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();

		render(NewChatFormTestHost, { props: { onStartChat } });

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const messageInput = screen.getByPlaceholderText(
			'How can I help you today?',
		) as HTMLTextAreaElement;
		await fireEvent.input(messageInput, { target: { value: 'start while pin saves' } });
		const startButton = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		await waitFor(() => {
			expect(startButton.disabled).toBe(false);
		});

		const toggleButton = screen.getByRole('button', { name: 'Pin project path' });
		expect(document.querySelector('[data-slot="new-chat-pinned-paths-hint"]')?.classList.contains('rounded-md')).toBe(true);
		await fireEvent.click(toggleButton);

		const projectPathInput = screen.getByLabelText('Project Path') as HTMLInputElement;
		expect(toggleButton.getAttribute('aria-busy')).toBe('true');
		expect(toggleButton.querySelector('.animate-spin')).toBeTruthy();
		expect(projectPathInput.readOnly).toBe(true);
		expect(
			(screen.getByRole('button', { name: '/workspace/project' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(startButton.disabled).toBe(false);

		await fireEvent.click(startButton);
		expect(onStartChat).toHaveBeenCalledTimes(1);

		pending.resolve({
			success: true,
			settings: makeSnapshot({
				version: 2,
				paths: {
					recentProjectPaths: ['/workspace/project'],
					pinnedProjectPaths: ['/workspace/project'],
				},
			}),
		});
		await waitFor(() => {
			expect(toggleButton.getAttribute('aria-busy')).toBe('false');
		});
	});

	it('opens the worktree picker as a separate dialog when the project is a git repo', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
			}),
		);
		validate.mockResolvedValue({
			valid: true,
			isGitRepo: true,
		});
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			...localScope,
			worktrees: [
				{
					name: 'main',
					path: '/workspace/project',
					branch: 'main',
					isCurrent: true,
					isMain: true,
					isPathMissing: false,
					lastModifiedAt: null,
				},
			],
		});

		render(NewChatFormTestHost);

		const openButton = await screen.findByRole('button', { name: 'Select a different worktree' });
		await fireEvent.click(openButton);

		const worktreeDialog = await screen.findByRole('dialog', { name: 'Select worktree' });
		expect(worktreeDialog).toBeTruthy();
		expect(worktreeDialog.textContent).toContain('New worktree');

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Select worktree' })).toBeNull();
		});
	});

	it.each([
		{ initial: 'default', model: 'default', discovered: false },
		{ initial: 'default', model: 'sample-model-high', discovered: true },
		{ initial: 'sample-model-high', model: 'default', discovered: true },
	])('starts a remote Antigravity chat with $model from $initial', async ({ initial, model, discovered }) => {
		stubMatchMedia(false);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		const catalog = new ModelCatalogStore();
		setAntigravityModels(catalog.forExecutor(remoteExecutor.id), [
			{ value: 'default', label: 'Default' },
			...(discovered ? [{ value: 'sample-model-high', label: 'Sample model (High)' }] : []),
		]);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot({
			recentAgentSettings: [{
				executorId: remoteExecutor.id, agentId: 'antigravity', model: initial,
				apiProviderId: null, modelEndpointId: null, modelProtocol: null,
			}],
			paths: { byExecutor: { [remoteExecutor.id]: { recentPaths: ['/worker/project'], pinnedPaths: [] } } },
			executionDefaults: { byAgent: { antigravity: { permissionMode: 'plan' } } },
		}));
		const onStartChat = vi.fn();
		render(NewChatFormTestHost, { catalog, executorSnapshots: [localExecutor, remoteExecutor], onStartChat });
		const picker = await screen.findByRole('button', {
			name: initial === 'default' ? 'Antigravity Default' : 'Antigravity Sample model (High)',
		});
		await fireEvent.click(picker);
		await fireEvent.click(await screen.findByRole('option', { name: model === 'default' ? 'Default' : 'Sample model (High)' }));
		expect(screen.queryByRole('button', { name: /Thinking effort:/ })).toBeNull();
		const prompt = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(prompt, { target: { value: 'Synthetic prompt' } });
		const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start session' });
		await waitFor(() => expect(start.disabled).toBe(false));
		await fireEvent.click(start);
		expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({
			executorId: remoteExecutor.id, agentId: 'antigravity', model, permissionMode: 'plan',
			thinkingMode: 'none', modelEndpointId: null, apiProviderId: null, projectPath: '/worker/project',
		}), expect.any(String));
	});

	it('selects native Default when the new executor does not offer the previous Antigravity model', async () => {
		stubMatchMedia(false);
		const catalog = new ModelCatalogStore();
		setAntigravityModels(catalog, [{ value: 'local-only', label: 'Local model' }]);
		setAntigravityModels(catalog.forExecutor(remoteExecutor.id), [
			{ value: 'default', label: 'Default' },
			{ value: 'worker-model', label: 'Worker model' },
		]);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot({
			recentAgentSettings: [{
				executorId: localExecutor.id, agentId: 'antigravity', model: 'local-only',
				apiProviderId: null, modelEndpointId: null, modelProtocol: null,
			}],
			paths: { byExecutor: { [remoteExecutor.id]: { recentPaths: [], pinnedPaths: ['/worker/project'] } } },
		}));
		render(NewChatFormTestHost, { catalog, executorSnapshots: [localExecutor, remoteExecutor] });
		await screen.findByRole('button', { name: 'Antigravity Local model' });
		await fireEvent.click(screen.getByRole('button', { name: 'Other executors…' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Worker: /worker/project' }));
		expect(await screen.findByRole('button', { name: 'Antigravity Default' })).toBeTruthy();
	});

	it('opens the model selector at recents when multiple recent targets exist', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'claude',
						model: 'opus',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
					{
						agentId: 'codex',
						model: 'gpt-5.4',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		render(NewChatFormTestHost);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Claude Opus' }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Claude · Claude OAuth · Opus' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Codex · OpenAI OAuth · GPT-5.4' })).toBeTruthy();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
	});

	it('hides direct agents and direct recents when direct chats are disabled', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'direct-openai-compatible',
						model: 'chat-model',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
					{
						agentId: 'claude',
						model: 'opus',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		render(NewChatFormTestHost);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Claude Opus' }));

		expect(
			document.querySelector('[data-slot="model-selector-agent-group"][data-group="direct"]'),
		).toBeNull();
		expect(
			document.querySelector('[data-slot="model-selector-agent-group"][data-group="agents"]'),
		).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Chat Completions' })).toBeNull();
		expect(screen.queryByText('Direct (Chat Completions) · Chat Model')).toBeNull();
	});

	it('shows grouped direct agents when direct chats are enabled', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'direct-openai-compatible',
						model: 'chat-model',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		render(NewChatFormTestHost, { allowDirectChats: true });

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const trigger = screen.getByRole('button', {
			name: /Direct \(Chat Completions\).*Chat Model/,
		});
		await fireEvent.click(trigger);

		const groupHeaders = Array.from(
			document.querySelectorAll<HTMLElement>('[data-slot="model-selector-agent-group"]'),
		);
		expect(groupHeaders.map((header) => header.textContent?.trim())).toEqual(['Direct', 'Agents']);
		expect(screen.getByRole('button', { name: 'Chat Completions' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Responses' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Anthropic' })).toBeTruthy();
	});

	it('reconciles an open direct selection when direct chats are disabled', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'direct-openai-compatible',
						model: 'chat-model',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
					{
						agentId: 'claude',
						model: 'opus',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		const view = render(NewChatFormTestHost, { allowDirectChats: true });
		await waitFor(() => {
			expect(
				screen.getByRole('button', {
					name: /Direct \(Chat Completions\).*Chat Model/,
				}),
			).toBeTruthy();
		});

		await view.rerender({ allowDirectChats: false });

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Claude Opus' })).toBeTruthy();
		});
		expect(
			screen.queryByRole('button', {
				name: /Direct \(Chat Completions\).*Chat Model/,
			}),
		).toBeNull();
	});

	it('opens the model selector at the selected model when only one recent target exists', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot());

		render(NewChatFormTestHost);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Claude Opus' }));

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(listbox).toBeTruthy();
		expect(screen.queryByText('Recent models')).toBeNull();
	});

	it('expands /snippet for review before starting a new chat', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'Review the API in /workspace/project',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review the API' } });

		const start = screen.getByRole('button', { name: 'Start session' });
		start.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(messageInput);

		await waitFor(() => expect(messageInput.value).toBe('Review the API in /workspace/project'));
		expect(onStartChat).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'value', value: 'the API' },
				context: {
					type: 'new-chat',
					executorId: 'local',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledTimes(1);
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ firstMessage: 'Review the API in /workspace/project' }),
			PROSPECTIVE_CHAT_ID,
		);
	});

	it('inserts a named preamble into a new-chat draft locally without server calls', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat, {
			preambleSnapshot: {
				revision: 1,
				preambles: [
					{
						id: '00000000-0000-4000-8000-000000000001',
						enabled: false,
						title: 'Manual',
						snippetShortName: 'manual',
						content: 'Literal {{arguments}} for {{chat_id}}',
						scope: { type: 'global' },
						agentIds: [],
						tagFilter: { mode: 'any', tags: [] },
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
					},
				],
			},
		});
		await inputAtCaret(messageInput, 'Before ;;manual after', 'Before ;;manual'.length);
		await fireEvent.click(await screen.findByRole('option', { name: /^manual\b/ }));

		await waitFor(() =>
			expect(messageInput.value).toBe(`Before Literal {{arguments}} for ${PROSPECTIVE_CHAT_ID} after`),
		);
		expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull();
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
		expect(onStartChat).not.toHaveBeenCalled();

		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({
				firstMessage: `Before Literal {{arguments}} for ${PROSPECTIVE_CHAT_ID} after`,
			}),
			PROSPECTIVE_CHAT_ID,
		);
	});

	it('mints the prospective ID lazily and retains it with the draft on a new open request', async () => {
		stubMatchMedia(false);
		vi.mocked(clientChatId.createClientChatId)
			.mockReset()
			.mockReturnValueOnce(PROSPECTIVE_CHAT_ID)
			.mockReturnValueOnce(RESEEDED_CHAT_ID);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'expanded prompt',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);

		await fireEvent.input(messageInput, { target: { value: '/snippet review first' } });
		expect(clientChatId.createClientChatId).not.toHaveBeenCalled();
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() => expect(messageInput.value).toBe('expanded prompt'));
		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(1);
		await fireEvent.input(messageInput, { target: { value: 'edited prompt' } });
		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(1);

		await fireEvent.click(screen.getByTestId('reseed-new-chat'));
		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(1);
		const replacementInput = screen.getByPlaceholderText('How can I help you today?');
		expect(replacementInput).toHaveProperty('value', 'edited prompt');
		await fireEvent.input(replacementInput, { target: { value: 'after reseed' } });
		await waitFor(() => {
			expect(
				(screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
			).toBe(false);
		});
		await fireEvent.keyDown(replacementInput, { key: 'Enter' });

		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(1);
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ firstMessage: 'after reseed' }),
			PROSPECTIVE_CHAT_ID,
		);
	});

	it('cancels an in-flight expansion on a new open request', async () => {
		stubMatchMedia(false);
		vi.mocked(clientChatId.createClientChatId)
			.mockReset()
			.mockReturnValueOnce(PROSPECTIVE_CHAT_ID)
			.mockReturnValueOnce(RESEEDED_CHAT_ID);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review stale ID' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		await fireEvent.click(screen.getByTestId('reseed-new-chat'));
		const replacementInput = screen.getByPlaceholderText<HTMLTextAreaElement>('How can I help you today?');
		await fireEvent.input(replacementInput, { target: { value: 'after reseed' } });
		pending.resolve({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(replacementInput.value).toBe('after reseed');
		await waitFor(() => {
			expect(
				(screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
			).toBe(false);
		});
		await fireEvent.keyDown(replacementInput, { key: 'Enter' });

		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			expect.objectContaining({
				context: expect.objectContaining({ chatId: PROSPECTIVE_CHAT_ID }),
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ firstMessage: 'after reseed' }),
			RESEEDED_CHAT_ID,
		);
	});

	it('distinguishes omitted slash arguments from an explicit empty value', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValue({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'expanded',
		});
		const messageInput = await renderSubmittableForm(vi.fn());

		await fireEvent.input(messageInput, { target: { value: '/s review' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() => expect(messageInput.value).toBe('expanded'));
		await fireEvent.input(messageInput, { target: { value: '/s review ' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() => expect(messageInput.value).toBe('expanded'));

		expect(snippetsApi.expandSnippet).toHaveBeenNthCalledWith(
			1,
			{
				shortName: 'review',
				arguments: { type: 'default' },
				context: {
					type: 'new-chat',
					executorId: 'local',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(snippetsApi.expandSnippet).toHaveBeenNthCalledWith(
			2,
			{
				shortName: 'review',
				arguments: { type: 'value', value: '' },
				context: {
					type: 'new-chat',
					executorId: 'local',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('opens from an inline trigger and replaces the captured span locally in the first message', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat, {
			snippetTemplate: 'Expanded review',
		});
		const source = 'Before ;;review after';

		await inputAtCaret(messageInput, source, 'Before ;;review'.length);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		expect(search.value).toBe('review');
		await fireEvent.click(screen.getByRole('option', { name: /^review\b/ }));

		await waitFor(() => expect(messageInput.value).toBe('Before Expanded review after'));
		expect(messageInput.selectionStart).toBe('Before Expanded review'.length);
		expect(onStartChat).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
		expect(clientChatId.createClientChatId).not.toHaveBeenCalled();
	});

	it('expands /s locally in new-chat drafts when WS is connected and reuses the prospective chat ID on submit', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat, {
			snippetTemplate: 'Review {{arguments}} for {{chat_id}}',
			snippetDefaultArguments: 'open PRs',
			preloadSnippets: true,
			wsPhase: 'connected',
		});

		await fireEvent.input(messageInput, { target: { value: '/s review' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() =>
			expect(messageInput.value).toBe(`Review open PRs for ${PROSPECTIVE_CHAT_ID}`),
		);
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
		expect(onStartChat).not.toHaveBeenCalled();

		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ firstMessage: `Review open PRs for ${PROSPECTIVE_CHAT_ID}` }),
			PROSPECTIVE_CHAT_ID,
		);
	});

	it('falls back to the server for /s with controller date tokens even when catalog is fresh', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'Daily notes 2026-01-01',
		});
		const messageInput = await renderSubmittableForm(vi.fn(), {
			snippetTemplate: 'Daily notes {{current_date_local}}',
			preloadSnippets: true,
			wsPhase: 'connected',
		});

		await fireEvent.input(messageInput, { target: { value: '/s review' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() => expect(messageInput.value).toBe('Daily notes 2026-01-01'));
		expect(snippetsApi.expandSnippet).toHaveBeenCalledOnce();
	});

	it('reopens arguments with preserved draft when local new-chat expansion exceeds the output limit', async () => {
		stubMatchMedia(false);
		const messageInput = await renderSubmittableForm(vi.fn(), {
			snippetTemplate: '{{arguments}}{{arguments}}{{arguments}}',
		});
		await fireEvent.input(messageInput, { target: { value: 'Keep draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		const largeArgs = 'x'.repeat(30_000);
		await fireEvent.input(argumentsInput, { target: { value: largeArgs } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText(/Expanded snippet exceeds 64000 characters/);
		const reopened = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(reopened.value).toBe(largeArgs);
		expect(messageInput.value).toBe('Keep draft');
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
	});

	it.each(['conversation', 'literal'] as const)('inserts an explicit snippet into a new %s draft', async (executionPolicy) => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'EXPANDED',
		});
		const messageInput = await renderSubmittableForm(vi.fn(), {
			snippetDefaultArguments: 'saved default',
			executionPolicy,
		});
		await fireEvent.input(messageInput, { target: { value: 'Before replace after' } });
		messageInput.setSelectionRange(7, 14);
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(argumentsInput.value).toBe('saved default');
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await waitFor(() => expect(messageInput.value).toBe('Before EXPANDED after'));
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'value', value: 'saved default' },
				context: {
					type: 'new-chat',
					executorId: 'local',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('preserves the invocation and reports a failed expansion', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockRejectedValueOnce(new Error('server unavailable'));
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review keep this' } });

		await fireEvent.keyDown(messageInput, { key: 'Enter' });

		await screen.findByText('Snippet expansion failed: server unavailable');
		expect(messageInput.value).toBe('/snippet review keep this');
		expect(messageInput.readOnly).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it.each([
		['source', { source: 'preamble' as const, sourceId: 'snippet-review' }],
		['ID', { source: 'snippet' as const, sourceId: 'replacement-review' }],
	])('rejects a menu expansion when the selected snippet %s changed', async (_change, identity) => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			...identity,
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'new chat draft' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('That snippet changed. Select it again.');
		await waitFor(() => expect(screen.getByTestId('snippet-load-count').textContent).toBe('2'));
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('rejects a menu expansion when the selected snippet was edited in place', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-02T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'new chat draft' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('That snippet changed. Select it again.');
		await waitFor(() => expect(screen.getByTestId('snippet-load-count').textContent).toBe('2'));
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('explains and blocks palette insertion when no project path is set', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.input(screen.getByRole('textbox', { name: 'Project Path' }), {
			target: { value: '   ' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await screen.findByText('Set a project path to insert snippets');
		const option = screen.getByRole('option', { name: /^review/ });
		expect(option.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(option);

		expect(screen.getByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('keeps the focused composer action when path validation finishes', async () => {
		stubMatchMedia(false);
		await renderSubmittableForm(vi.fn());
		const validation = deferred<ValidateStartResponse>();
		validate.mockClear().mockReturnValueOnce(validation.promise);
		await fireEvent.input(screen.getByRole('textbox', { name: 'Project Path' }), {
			target: { value: '/workspace/next' },
		});
		await waitFor(() => expect(validate).toHaveBeenCalled());
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		const snippets = await screen.findByRole('menuitem', { name: /Snippets/ });
		snippets.focus();
		validation.resolve({ valid: true, isGitRepo: false });
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty('disabled', false),
		);
		expect(document.activeElement).toBe(snippets);
	});

	it('does not let late path validation steal focus from argument entry', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		await renderSubmittableForm(onStartChat);
		const pendingValidation = deferred<ValidateStartResponse>();
		const validationCallCount = validate.mock.calls.length;
		validate.mockReturnValueOnce(pendingValidation.promise);
		await fireEvent.input(screen.getByRole('textbox', { name: 'Project Path' }), {
			target: { value: '/workspace/next' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await waitFor(() =>
			expect(validate).toHaveBeenCalledTimes(validationCallCount + 1),
		);

		pendingValidation.resolve({ valid: true, isGitRepo: false });
		await pendingValidation.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await waitFor(() => expect(document.activeElement).toBe(argumentsInput));
		expect(screen.getByRole('dialog', { name: 'Arguments for /snippet review' })).toBeTruthy();
	});

	it('cancels a pending snippet when the execution policy becomes literal', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		const { rerender } = render(NewChatFormTestHost);
		await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull());
		const input = screen.getByPlaceholderText<HTMLTextAreaElement>('How can I help you today?');
		await fireEvent.input(input, { target: { value: '/snippet review source' } });
		await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start session' }).disabled).toBe(false));
		await fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() => expect(snippetsApi.expandSnippet).toHaveBeenCalledOnce());
		await rerender({ executionPolicy: 'literal' });
		await waitFor(() => expect(vi.mocked(snippetsApi.expandSnippet).mock.calls[0][1]?.signal?.aborted).toBe(true));
		pending.resolve({ success: true, source: 'snippet', sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z', shortName: 'review',
			contextExecutorId: 'local', contextProjectPath: '/workspace/project', expandedText: 'Must not apply' });
		await pending.promise;
		expect(input.value).toBe('/snippet review source');
	});

	it.each(['conversation', 'literal'] as const)('blocks unsupported attachments regardless of input policy: %s', async (executionPolicy) => {
		const source = 'printf command';
		stubMatchMedia(false);
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		const onStartChat = vi.fn();
		const { container, rerender } = render(NewChatFormTestHost, { onStartChat });
		const input = screen.getByPlaceholderText<HTMLTextAreaElement>('How can I help you today?');
		await fireEvent.input(input, { target: { value: source } });
		await fireEvent.change(container.querySelector('input[type="file"]')!, {
			target: { files: [new File(['notes'], 'notes.pdf', { type: 'application/pdf' })] },
		});
		const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Start session' });
		await waitFor(() => expect(send.disabled).toBe(false));
		await rerender({ executionPolicy });
		expect(send.disabled).toBe(false);
		expect(screen.queryByText(/Remove attachments before submitting/)).toBeNull();
		await rerender({ executionPolicy, supportsImages: false, fileAttachmentMimeTypes: [] });
		expect(await screen.findByText(/Remove attachments before submitting/)).toBeTruthy();
		expect(send.disabled).toBe(true);
		await fireEvent.click(send);
		await fireEvent.keyDown(input, { key: 'Enter' });
		await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
		expect(onStartChat).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Remove attachment notes.pdf' }));
		expect(send.disabled).toBe(!source);
		expect(screen.queryByText(/Remove attachments before submitting/)).toBeNull();
	});

	it('does not apply a pending expansion after the project path changes', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review old path' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		const pathInput = screen.getByRole('textbox', { name: 'Project Path' });
		await fireEvent.input(pathInput, { target: { value: '/workspace/other' } });
		pending.resolve({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('/snippet review old path');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('keeps the composer editable and cancels a pending expansion when the user types', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'cancellable' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });
		expect(document.activeElement).toBe(messageInput);
		expect(messageInput.readOnly).toBe(false);
		const pendingEnter = new KeyboardEvent('keydown', {
			key: 'Enter',
			bubbles: true,
			cancelable: true,
		});
		messageInput.dispatchEvent(pendingEnter);
		expect(pendingEnter.defaultPrevented).toBe(true);

		await fireEvent.input(messageInput, { target: { value: 'User edit wins' } });
		expect(messageInput.value).toBe('User edit wins');
		expect(messageInput.readOnly).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
		pending.resolve({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('User edit wins');
	});

	it('accepts a pasted image and cancels a pending expansion', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'cancellable' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		const attachment = new File(['image'], 'pasted.png', { type: 'image/png' });
		await fireEvent.paste(messageInput, {
			clipboardData: {
				items: [{ kind: 'file', type: 'image/png', getAsFile: () => attachment }],
			},
		});

		expect(screen.getByRole('button', { name: 'Remove attachment pasted.png' })).toBeTruthy();
		expect(document.querySelector('[data-slot="composer-attachment-preview"]')?.classList.contains('rounded-lg')).toBe(true);
		const expansionOptions = vi.mocked(snippetsApi.expandSnippet).mock.calls[0]?.[1];
		expect(expansionOptions?.signal?.aborted).toBe(true);
		pending.resolve({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('ignores an unsupported pasted image without cancelling a pending expansion', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat, { supportsImages: false });
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'still running' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		const attachment = new File(['image'], 'unsupported.png', { type: 'image/png' });
		await fireEvent.paste(messageInput, {
			clipboardData: {
				items: [{ kind: 'file', type: 'image/png', getAsFile: () => attachment }],
			},
		});

		expect(screen.queryByRole('button', { name: 'Remove attachment unsupported.png' })).toBeNull();
		const expansionOptions = vi.mocked(snippetsApi.expandSnippet).mock.calls[0]?.[1];
		expect(expansionOptions?.signal?.aborted).toBe(false);
		pending.resolve({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'expansion still applies',
		});

		await pending.promise;
		await waitFor(() => expect(messageInput.value).toContain('expansion still applies'));
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('lets another form control cancel a pending expansion with Escape', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review cancel this' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		const permissionButton = screen.getByRole('button', { name: 'Permission mode: Default' });
		expect(permissionButton).toBeTruthy();
		if (!permissionButton) throw new Error('Missing permission control');
		permissionButton.focus();
		await fireEvent.keyDown(permissionButton, { key: 'Escape' });

		expect(messageInput.value).toBe('/snippet review cancel this');
		expect(messageInput.readOnly).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
		pending.resolve({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('/snippet review cancel this');
	});
});


describe('New Chat executor pin scope', () => {
	it.each([
		{ mobile: false, explicitFocus: false },
		{ mobile: false, explicitFocus: true },
		{ mobile: true, explicitFocus: false },
		{ mobile: true, explicitFocus: true },
	])('yields opening autofocus to focus inside the picker (mobile=$mobile, explicitFocus=$explicitFocus)', async ({ mobile, explicitFocus }) => {
		stubMatchMedia(mobile);
		const frames = new Map<number, FrameRequestCallback>();
		let frameId = 0;
		async function flushFrames(): Promise<void> {
			for (let round = 0; round < 5; round++) {
				await tick();
				const pending = [...frames.values()];
				frames.clear();
				for (const callback of pending) callback(performance.now());
			}
		}
		try {
			validate.mockResolvedValue({ valid: true, isGitRepo: false });
			vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
				makeSnapshot({
					paths: {
						recentProjectPaths: ['/same'],
						pinnedProjectPaths: ['/same'],
						byExecutor: {
							[remoteExecutor.id]: { recentPaths: [], pinnedPaths: ['/first', '/same'] },
						},
					},
				}),
			);
			render(NewChatFormTestHost, { props: { executorSnapshots: [localExecutor, remoteExecutor] } });
			const toggle = await screen.findByRole('button', { name: 'Other executors…' });
			await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText('How can I help you today?')));
			vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
				frames.set(++frameId, callback);
				return frameId;
			});
			vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
			toggle.focus();
			await fireEvent.click(toggle);
			const intendedPin = screen.getByRole('button', { name: 'Worker: /same' });
			if (explicitFocus) {
				intendedPin.focus();
				expect(document.activeElement).toBe(intendedPin);
			}
			await flushFrames();
			if (explicitFocus) {
				expect(document.activeElement).toBe(intendedPin);
				await fireEvent.click(intendedPin);
				expect(screen.getByRole('button', { name: '/same' }).getAttribute('aria-pressed')).toBe('true');
				await waitFor(() => expect(validate).toHaveBeenLastCalledWith('/same', { executorId: remoteExecutor.id }));
			} else if (mobile) {
				expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
			} else {
				expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Worker: /first' }));
			}
		} finally {
			try {
				cleanup();
				await flushFrames();
			} finally {
				vi.unstubAllGlobals();
			}
		}
	});

	it('focuses the prompt on a remote pin choice, not on its later validation', async () => {
		validate.mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				paths: {
					recentProjectPaths: ['/same'],
					pinnedProjectPaths: ['/same'],
					byExecutor: {
						[remoteExecutor.id]: { recentPaths: [], pinnedPaths: ['/same', '/worker/pin'] },
					},
				},
			}),
		);
		render(NewChatFormTestHost, { props: { executorSnapshots: [localExecutor, remoteExecutor] } });
		const toggle = await screen.findByRole('button', { name: 'Other executors…' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByRole('button', { name: 'Worker: /worker/pin' })).toBeNull();
		await screen.findByRole('button', { name: '/same' });
		const prompt = screen.getByPlaceholderText('How can I help you today?') as HTMLTextAreaElement;
		await fireEvent.input(prompt, { target: { value: 'Synthetic retained draft' } });
		await fireEvent.click(toggle);
		expect(screen.queryByRole('button', { name: 'Local: /same' })).toBeNull();
		const remotePin = screen.getByRole('button', { name: 'Worker: /same' });
		expect(remotePin.getAttribute('aria-pressed')).toBe('false');
		const validation = deferred<ValidateStartResponse>();
		validate.mockReturnValue(validation.promise);
		await fireEvent.click(remotePin);
		await waitFor(() => expect(document.activeElement).toBe(prompt));
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		const executor = screen.getByRole('button', { name: 'Executor: Worker' });
		executor.focus();
		validation.resolve({ valid: true, isGitRepo: false });
		await waitFor(() => expect(document.querySelector('[data-slot="project-path-field"] .text-status-success-foreground')).toBeTruthy());
		expect(document.activeElement).toBe(executor);
		expect(screen.queryByRole('button', { name: 'Worker: /same' })).toBeNull();
		expect(screen.getByRole('button', { name: '/same' }).getAttribute('aria-pressed')).toBe('true');
		expect(prompt.value).toBe('Synthetic retained draft');
		await waitFor(() =>
			expect(validate).toHaveBeenLastCalledWith('/same', {
				executorId: remoteExecutor.id,
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Local: /same' })).toBeNull(),
		);
		expect(screen.getByRole('button', { name: '/worker/pin' })).toBeTruthy();
	});

	it('updates live pins and disables offline, disabled and removed owners without selecting Local', async () => {
		const snapshot = makeSnapshot({
			paths: {
				pinnedProjectPaths: ['/local'],
				byExecutor: {
					[remoteExecutor.id]: { recentPaths: [], pinnedPaths: ['/worker/pin'] },
					'33333333-3333-4333-8333-333333333333': { recentPaths: [], pinnedPaths: ['/removed'] },
				},
			},
		});
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(snapshot);
		let executors!: ExecutorsStore;
		let settings!: RemoteSettingsStore;
		render(NewChatFormTestHost, {
			props: {
				executorSnapshots: [localExecutor, { ...remoteExecutor, availability: 'offline' }],
				onExecutors: (store) => {
					executors = store;
				},
				onRemoteSettings: (store) => {
					settings = store;
				},
			},
		});
		await fireEvent.click(await screen.findByRole('button', { name: 'Other executors…' }));
		const pin = screen.getByRole('button', { name: 'Worker: /worker/pin' }) as HTMLButtonElement;
		expect(pin.disabled).toBe(true);
		expect(document.getElementById(pin.getAttribute('aria-describedby')!)?.textContent).toBe(
			'Waiting for connection',
		);
		expect(
			(
				screen.getByRole('button', {
					name: '33333333-3333-4333-8333-333333333333: /removed',
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		executors.applySnapshot([localExecutor, remoteExecutor]);
		await waitFor(() => expect(pin.disabled).toBe(false));
		executors.applySnapshot([localExecutor, { ...remoteExecutor, enabled: false }]);
		await waitFor(() => expect(pin.disabled).toBe(true));
		settings.applySnapshot({
			...snapshot,
			paths: { ...snapshot.paths, pinnedProjectPaths: ['/updated'] },
		});
		await screen.findByRole('button', { name: '/updated' });
		expect(screen.queryByRole('button', { name: '/local' })).toBeNull();
		executors.applySnapshot([localExecutor]);
		await screen.findByRole('button', { name: remoteExecutor.id + ': /worker/pin' });
	});

	it('retains the picker trigger after selecting the only executor with pins', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				paths: {
					byExecutor: { [remoteExecutor.id]: { recentPaths: [], pinnedPaths: ['/worker/pin'] } },
				},
			}),
		);
		render(NewChatFormTestHost, { props: { executorSnapshots: [localExecutor, remoteExecutor] } });
		const toggle = await screen.findByRole('button', { name: 'Other executors…' });
		toggle.focus();
		await fireEvent.click(toggle);
		const pin = screen.getByRole('button', { name: 'Worker: /worker/pin' });
		pin.focus();
		await fireEvent.click(pin);
		toggle.focus();
		expect(toggle.isConnected).toBe(true);
		expect(document.activeElement).toBe(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		const path = screen.getByLabelText('Project Path');
		path.focus();
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Other executors…' })).toBe(toggle),
		);
		expect(document.activeElement).toBe(path);
	});

	it('retains the focused picker trigger when a live update removes the final other pin', async () => {
		const snapshot = makeSnapshot({
			paths: {
				pinnedProjectPaths: ['/local'],
				byExecutor: { [remoteExecutor.id]: { recentPaths: [], pinnedPaths: ['/worker/pin'] } },
			},
		});
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(snapshot);
		let settings!: RemoteSettingsStore;
		render(NewChatFormTestHost, {
			props: {
				executorSnapshots: [localExecutor, remoteExecutor],
				onRemoteSettings: (store) => {
					settings = store;
				},
			},
		});
		const toggle = await screen.findByRole('button', { name: 'Other executors…' });
		toggle.focus();
		settings.applySnapshot({ ...snapshot, paths: { ...snapshot.paths, byExecutor: {} } });
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Other executors…' })).toBe(toggle),
		);
		expect(document.activeElement).toBe(toggle);
		const path = screen.getByLabelText('Project Path');
		path.focus();
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Other executors…' })).toBe(toggle),
		);
		expect(document.activeElement).toBe(path);
	});

	it('adds no picker trigger for a workspace with only local pins', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { pinnedProjectPaths: ['/local'] } }),
		);
		render(NewChatFormTestHost);
		await screen.findByRole('button', { name: '/local' });
		expect(screen.queryByRole('button', { name: 'Other executors…' })).toBeNull();
	});
});
