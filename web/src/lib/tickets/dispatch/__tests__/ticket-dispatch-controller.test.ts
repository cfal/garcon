import { describe, expect, it, vi } from 'vitest';
import { ModelCatalogStore, type AgentMetadata } from '$lib/agents/model-catalog-store.svelte';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import type { NewChatConfig } from '$lib/types/app.js';
import type { ChatId } from '$shared/chat-id';
import type { RemoteSettingsSnapshot, TicketDispatchUiSettings, UpdateRemoteSettingsInput } from '$shared/settings';
import {
	TicketDispatchController,
	ticketDispatchAssignment,
	type DispatchableTicket,
	type TicketDispatchControllerDeps,
	type TicketDispatchMutations,
} from '../ticket-dispatch-controller.svelte.js';
import { DispatchSessionsHarness } from './ticket-dispatch-sessions-harness.svelte.js';

const CHAT_ID = '1790000000000001' as ChatId;

function metadata(id: string, defaultModel: string): AgentMetadata {
	return {
		id,
		label: id,
		supportsCompact: false,
		supportsFork: false,
		supportsForkAtMessage: false,
		supportsForkWhileRunning: false,
		supportsUpdateProjectPath: true,
		supportsSteering: true,
		supportsImages: false,
		fileAttachmentMimeTypes: [],
		acceptsApiProviderEndpoints: false,
		supportedProtocols: [],
		authLoginSupported: false,
		supportedPermissionModes: ['default'],
		supportedThinkingModes: ['none', 'high'],
		settings: [],
		defaultSettings: { ownerId: id, schemaVersion: 1, values: {} },
		defaultModel,
	};
}

const ticket: DispatchableTicket = {
	id: 'G-1',
	title: 'Move things out of memory',
	project: '/repo',
	description: 'Stop re-reading exposure per order.',
	revision: 1,
	status: 'open',
};

function fixture(options: { ticketDispatch?: TicketDispatchUiSettings; projectValid?: boolean } = {}) {
	const catalog = new ModelCatalogStore();
	catalog.agentMetadata = { claude: metadata('claude', 'opus'), codex: metadata('codex', 'gpt-5.5') };
	catalog.agentModels = {
		claude: [{ value: 'opus', label: 'Opus' }],
		codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
	};
	catalog.lastValidatedAt = Date.now();
	let snapshot: RemoteSettingsSnapshot = makeRemoteSettingsSnapshot({
		ui: options.ticketDispatch ? { ticketDispatch: options.ticketDispatch } : {},
	});
	const updates: UpdateRemoteSettingsInput[] = [];
	const remoteSettings: TicketDispatchControllerDeps['remoteSettings'] = {
		get snapshot() {
			return snapshot;
		},
		ensureLoaded: async () => snapshot,
		update: async (patch) => {
			updates.push(patch);
			snapshot = { ...snapshot, ui: { ...snapshot.ui, ...patch.ui } };
			return snapshot;
		},
	};
	const sessions = new DispatchSessionsHarness();
	const started: { chatId: ChatId; config: NewChatConfig }[] = [];
	const notifications = { error: vi.fn() };
	const mutations = { mutate: vi.fn(async () => true) } satisfies TicketDispatchMutations;
	const controller = new TicketDispatchController({
		remoteSettings,
		modelCatalog: catalog,
		sessions,
		notifications,
		startChat: (chatId, config) => {
			started.push({ chatId, config });
			sessions.setStatus(chatId, 'draft');
		},
		validateProject: async () =>
			options.projectValid === false ? { valid: false, error: 'Path not found' } : { valid: true },
		createChatId: () => CHAT_ID,
		startTimeoutMs: 1_000,
	});
	return { controller, sessions, started, notifications, mutations, updates };
}

describe('TicketDispatchController.dispatch', () => {
	it('starts a chat with the ticket prompt and assigns the ticket once the chat starts', async () => {
		const { controller, sessions, started, mutations } = fixture({
			ticketDispatch: { agentId: 'codex', model: 'gpt-5.5', thinkingMode: 'high', customPrompt: 'Fix: {{ticket}}' },
		});

		const dispatched = controller.dispatch(ticket, mutations);
		await vi.waitFor(() => expect(started).toHaveLength(1));
		expect(started[0]).toEqual({
			chatId: CHAT_ID,
			config: expect.objectContaining({
				executorId: 'local',
				agentId: 'codex',
				projectPath: '/repo',
				model: 'gpt-5.5',
				permissionMode: 'default',
				thinkingMode: 'high',
				firstMessage: 'Fix: Ticket G-1: Move things out of memory\nProject: /repo\n\nStop re-reading exposure per order.',
			}),
		});
		expect(controller.isDispatching('G-1')).toBe(false);
		expect(mutations.mutate).not.toHaveBeenCalled();

		sessions.setStatus(CHAT_ID, 'running');
		await expect(dispatched).resolves.toBe(true);
		expect(mutations.mutate).toHaveBeenCalledWith(ticket, {
			action: 'update',
			ticketId: 'G-1',
			expectedRevision: 1,
			patch: { assignee: { kind: 'chat', chatId: CHAT_ID }, status: 'in-progress' },
		});
	});

	it('skips assignment when the draft chat is discarded before it starts', async () => {
		const { controller, sessions, started, mutations } = fixture();

		const dispatched = controller.dispatch(ticket, mutations);
		await vi.waitFor(() => expect(started).toHaveLength(1));
		sessions.remove(CHAT_ID);

		await expect(dispatched).resolves.toBe(true);
		expect(mutations.mutate).not.toHaveBeenCalled();
	});

	it('reports an invalid ticket project without starting a chat', async () => {
		const { controller, started, notifications, mutations } = fixture({ projectValid: false });

		await expect(controller.dispatch(ticket, mutations)).resolves.toBe(false);

		expect(started).toHaveLength(0);
		expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('/repo'));
	});

	it('reports an unavailable saved model instead of dispatching with another model', async () => {
		const { controller, started, notifications, mutations } = fixture({
			ticketDispatch: { agentId: 'claude', model: 'retired' },
		});

		await expect(controller.dispatch(ticket, mutations)).resolves.toBe(false);

		expect(started).toHaveLength(0);
		expect(notifications.error).toHaveBeenCalledOnce();
	});

	it('ignores a second dispatch of the same ticket while the first is preparing', async () => {
		const { controller, sessions, started, mutations } = fixture();

		const first = controller.dispatch(ticket, mutations);
		await expect(controller.dispatch(ticket, mutations)).resolves.toBe(false);
		await vi.waitFor(() => expect(started).toHaveLength(1));
		sessions.setStatus(CHAT_ID, 'running');
		await first;

		expect(started).toHaveLength(1);
	});
});

describe('TicketDispatchController settings', () => {
	it('persists a model selection and keeps the custom prompt', async () => {
		const { controller, updates } = fixture({ ticketDispatch: { customPrompt: 'Do {{ticket}}' } });
		expect(controller.followsNewChatDefaults).toBe(true);

		await controller.persistSelection({
			executorId: 'local',
			agentId: 'codex',
			modelValue: 'gpt-5.5',
			model: 'gpt-5.5',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			thinkingMode: 'high',
		});

		expect(updates.at(-1)).toEqual({
			ui: {
				ticketDispatch: {
					customPrompt: 'Do {{ticket}}',
					executorId: 'local',
					agentId: 'codex',
					model: 'gpt-5.5',
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
					thinkingMode: 'high',
				},
			},
		});
		expect(controller.followsNewChatDefaults).toBe(false);
		expect(controller.selectorValue).toMatchObject({ agentId: 'codex', model: 'gpt-5.5', thinkingMode: 'high' });
	});

	it('returns to new-chat defaults without dropping the custom prompt', async () => {
		const { controller, updates } = fixture({
			ticketDispatch: { agentId: 'codex', model: 'gpt-5.5', customPrompt: 'Do {{ticket}}' },
		});

		await controller.followNewChat();

		expect(updates.at(-1)).toEqual({ ui: { ticketDispatch: { customPrompt: 'Do {{ticket}}' } } });
		expect(controller.followsNewChatDefaults).toBe(true);
		expect(controller.selectorValue).toMatchObject({ agentId: 'claude', model: 'opus' });
	});

	it('persists the dispatch prompt', async () => {
		const { controller, updates } = fixture({ ticketDispatch: { agentId: 'codex', model: 'gpt-5.5' } });

		await expect(controller.persistPrompt('Ship {{ticket}}')).resolves.toEqual({ ok: true });

		expect(updates.at(-1)).toEqual({
			ui: { ticketDispatch: { agentId: 'codex', model: 'gpt-5.5', customPrompt: 'Ship {{ticket}}' } },
		});
	});
});

describe('ticketDispatchAssignment', () => {
	it('keeps a ticket status that is already past open', () => {
		expect(ticketDispatchAssignment({ id: 'G-2', revision: 4, status: 'in-review' }, CHAT_ID)).toEqual({
			action: 'update',
			ticketId: 'G-2',
			expectedRevision: 4,
			patch: { assignee: { kind: 'chat', chatId: CHAT_ID } },
		});
	});
});
