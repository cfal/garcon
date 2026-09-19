import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '$lib/api/client';
import { createModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import type { ModelCatalogResponse } from '$shared/model-catalog';
import { ScheduledPromptFormState } from '../scheduled-prompt-form-state.svelte';

vi.mock('$lib/api/client', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/api/client')>(),
	apiFetch: vi.fn(),
}));

const catalogBody = {
	catalog: {
		agents: [{
			id: 'sample', label: 'Sample', kind: 'agent', defaultModel: 'cached',
			models: [{ value: 'cached', label: 'Cached Model' }],
			supportsCompact: false, supportsFork: false, supportsForkAtMessage: false,
			supportsForkWhileRunning: false, supportsUpdateProjectPath: false,
			supportsSteering: false, supportsImages: false, acceptsApiProviderEndpoints: false,
			supportedProtocols: [], authLoginSupported: false,
			supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
			settings: [], defaultSettings: { ownerId: 'sample', schemaVersion: 1, values: {} },
			requiresStrictModelDiscovery: false, generation: null,
		}],
		apiProviders: [],
	},
} satisfies ModelCatalogResponse;

describe.each(['local', '22222222-2222-4222-8222-222222222222'])('cached catalog retry on %s', (nodeId) => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(apiFetch).mockReset();
	});

	it.each([200, 304])('keeps new and scheduled admission closed until a successful %s retry', async (status) => {
		const root = createModelCatalogStore();
		const catalog = root.forNode(nodeId);
		vi.mocked(apiFetch).mockResolvedValueOnce(Response.json(catalogBody));
		await catalog.forceRefresh();
		expect(catalog.lastValidatedAt).not.toBeNull();
		const remoteSettings = new RemoteSettingsStore();
		const options = { modelCatalog: root, remoteSettings, selectableAgentIds: ['sample'] };
		const newChat = new NewChatFormState(options);
		const scheduled = new ScheduledPromptFormState(root, remoteSettings, {
			hasChat: () => false, isDraft: () => false,
		}, options);
		for (const startup of [newChat, scheduled.startup]) {
			startup.nodeId = nodeId;
			startup.agentId = 'sample';
			startup.settingsLoaded = true;
			startup.projectPath = '/workspace/project';
			startup.validationStatus = 'valid';
			startup.firstMessage = 'Synthetic initial prompt';
		}
		scheduled.date = '2099-01-02';
		scheduled.prompt = 'Synthetic scheduled prompt';
		const now = new Date('2099-01-01T00:00:00.000Z');
		const expectAdmission = (admitted: boolean) => {
			expect(newChat.canSubmit).toBe(admitted);
			expect(newChat.buildConfig() !== null).toBe(admitted);
			expect(scheduled.canSave).toBe(admitted);
			expect(scheduled.buildDefinition(now) !== null).toBe(admitted);
		};
		expectAdmission(true);
		vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
		await catalog.forceRefresh();
		expectAdmission(false);
		expect(catalog.lastValidatedAt).not.toBeNull();

		for (const outcome of ['failure', 'success'] as const) {
			const response = Promise.withResolvers<Response>();
			vi.mocked(apiFetch).mockReturnValueOnce(response.promise);
			const pending = catalog.forceRefresh();
			expect(catalog.isRefreshing).toBe(true);
			expect(catalog.error).toBe('Failed to fetch model catalog: 503');
			expectAdmission(false);
			expect(newChat.modelSelectionPending).toBe(true);
			expect(scheduled.startup.modelSelectionPending).toBe(true);
			response.resolve(outcome === 'failure' ? new Response(null, { status: 503 })
				: status === 304 ? new Response(null, { status }) : Response.json(catalogBody));
			await pending;
			expectAdmission(outcome === 'success');
		}
		expect(catalog.error).toBeNull();
		expect(newChat.firstMessage).toBe('Synthetic initial prompt');
		expect(scheduled.prompt).toBe('Synthetic scheduled prompt');
		newChat.dispose();
		scheduled.dispose();
	});
});
