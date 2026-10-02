import { vi } from 'vitest';
import { ModelCatalogStore, type AgentMetadata } from '$lib/agents/model-catalog-store.svelte';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';

function metadata(id: SessionAgentId, defaultModel: string): AgentMetadata {
	return {
		id, label: id, defaultModel, supportsCompact: false, supportsFork: false,
		supportsForkAtMessage: false, supportsForkWhileRunning: false,
		supportsUpdateProjectPath: true, supportsSteering: true, supportsImages: false,
		fileAttachmentMimeTypes: [], acceptsApiProviderEndpoints: false, supportedProtocols: [],
		authLoginSupported: false, supportedPermissionModes: ['default', 'acceptEdits'],
		supportedThinkingModes: ['none', 'high'], settings: [],
		defaultSettings: { ownerId: id, schemaVersion: 1, values: {} },
	};
}

export function executorStartupSnapshot() {
	return makeRemoteSettingsSnapshot({
		paths: {
			recentProjectPaths: ['/local/recent'],
			byExecutor: {
				[remoteExecutor.id]: { recentPaths: ['/worker/recent'], pinnedPaths: ['/worker/pinned'] },
			},
		},
		recentAgentSettings: [
			{ executorId: remoteExecutor.id, agentId: 'codex', model: 'worker-saved', apiProviderId: null, modelEndpointId: null, modelProtocol: null },
			{ agentId: 'claude', model: 'local-saved', apiProviderId: null, modelEndpointId: null, modelProtocol: null },
		],
	});
}

export function createExecutorStartupFixture() {
	const modelCatalog = new ModelCatalogStore();
	const remoteCatalog = modelCatalog.forExecutor(remoteExecutor.id);
	for (const [catalog, prefix] of [[modelCatalog, 'local'], [remoteCatalog, 'worker']] as const) {
		catalog.agentMetadata = {
			claude: metadata('claude', `${prefix}-default`),
			codex: metadata('codex', `${prefix}-default`),
		};
		catalog.agentModels = Object.fromEntries(['claude', 'codex'].map(id => [id, [
			{ value: `${prefix}-default`, label: `${prefix} default` },
			{ value: `${prefix}-saved`, label: `${prefix} saved` },
			{ value: `${prefix}-edited`, label: `${prefix} edited` },
		]]));
		catalog.lastValidatedAt = Date.now();
		vi.spyOn(catalog, 'refreshIfStale').mockResolvedValue();
	}
	const remoteSettings = new RemoteSettingsStore();
	remoteSettings.applySnapshot(executorStartupSnapshot());
	const executors = new ExecutorsStore();
	executors.applySnapshot([localExecutor, remoteExecutor]);
	return { modelCatalog, remoteCatalog, remoteSettings, executors };
}
