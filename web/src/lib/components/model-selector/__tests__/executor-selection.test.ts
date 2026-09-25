import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogStore, type AgentMetadata } from '$lib/agents/model-catalog-store.svelte';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { ModelSelectorState } from '../model-selector-state.svelte.ts';
import { buildModelSelectorRecents } from '../model-selector-recents';

function metadata(id: string): AgentMetadata {
	return {
		id, label: id, supportsCompact: false, supportsFork: false, supportsForkAtMessage: false,
		supportsForkWhileRunning: false, supportsUpdateProjectPath: true, supportsSteering: true,
		supportsImages: false, fileAttachmentMimeTypes: [], acceptsApiProviderEndpoints: false,
		supportedProtocols: [], authLoginSupported: false, supportedPermissionModes: ['default'],
		supportedThinkingModes: ['none'], settings: [],
		defaultSettings: { ownerId: id, schemaVersion: 1, values: {} }, defaultModel: 'same',
	};
}

function fixture(remoteAgent = 'sample', executor: 'fixed' | 'select' = 'select') {
	const executors = new ExecutorsStore();
	executors.applySnapshot([localExecutor, remoteExecutor]);
	const catalog = new ModelCatalogStore();
	const remote = catalog.forExecutor(remoteExecutor.id);
	catalog.agentMetadata = { sample: metadata('sample') };
	catalog.agentModels = { sample: [{ value: 'same', label: 'Local model' }] };
	remote.agentMetadata = { [remoteAgent]: metadata(remoteAgent) };
	remote.agentModels = { [remoteAgent]: [{ value: 'same', label: 'Worker model' }] };
	vi.spyOn(catalog, 'refreshIfStale').mockResolvedValue();
	vi.spyOn(remote, 'refreshIfStale').mockResolvedValue();
	const onChange = vi.fn();
	const selector = new ModelSelectorState({
		modelCatalog: catalog, executors, value: { executorId: 'local', agentId: 'sample', model: 'same' },
		mode: { executor, agent: 'select', source: 'select', surface: 'composer' },
		getRecents: (executorId) => buildModelSelectorRecents(catalog.forExecutor(executorId), [
			{ agentId: 'sample', model: 'same', apiProviderId: null, modelEndpointId: null, modelProtocol: null },
			{ executorId: remoteExecutor.id, agentId: remoteAgent, model: 'same', apiProviderId: null, modelEndpointId: null, modelProtocol: null },
		]),
		preferRecentsOnOpen: false, onChange,
		getSelectableAgentIds: (executorId) => catalog.forExecutor(executorId).getSelectableAgents(),
	});
	return { selector, executors, catalog, remote, onChange };
}

describe('model selector executor selection', () => {
	beforeEach(() => localStorage.clear());

	it('fixed-executor selection and recents cannot change hosts', async () => {
		const { selector, catalog, onChange } = fixture('sample', 'fixed');
		selector.openDraft();
		expect(selector.showExecutorPicker).toBe(false);
		await selector.selectExecutor(remoteExecutor.id);
		expect(selector.executorId).toBe('local');
		const recent = buildModelSelectorRecents(catalog.forExecutor(remoteExecutor.id), [{
			executorId: remoteExecutor.id, agentId: 'sample', model: 'same', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
		}])[0]!;
		selector.selectRecent(recent);
		expect(onChange).not.toHaveBeenCalled();
	});

	it('keeps executor browsing draft-only and commits the same model name on another executor', async () => {
		const { selector, onChange } = fixture();
		selector.openDraft();
		expect(selector.modelRows[0]?.label).toBe('Local model');
		expect(selector.recentOptions.map((recent) => recent.modelLabel)).toEqual(['Local model']);
		await selector.selectExecutor(remoteExecutor.id);
		expect(onChange).not.toHaveBeenCalled();
		expect(selector.committedExecutorId).toBe('local');
		expect(selector.executorId).toBe(remoteExecutor.id);
		expect(selector.triggerTitle).toContain('Local');
		expect(selector.triggerTitle).toContain('Local model');
		expect(selector.modelRows[0]?.label).toBe('Worker model');
		expect(selector.recentOptions.map((recent) => recent.modelLabel)).toEqual(['Worker model']);
		selector.selectModel('same');
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ executorId: remoteExecutor.id, agentId: 'sample', model: 'same' }));
	});

	it('uses destination inventory rather than filtering it through the source inventory', async () => {
		const { selector, onChange } = fixture('remote-only');
		selector.openDraft();
		await selector.selectExecutor(remoteExecutor.id);
		expect(selector.selectableAgentIds).toEqual(['remote-only']);
		expect(selector.agentId).toBe('remote-only');
		selector.selectModel('same');
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ executorId: remoteExecutor.id, agentId: 'remote-only' }));
	});

	it('discards a pending executor selection on close and rejects offline commits', async () => {
		const { selector, executors, remote, onChange } = fixture();
		selector.openDraft();
		const response = Promise.withResolvers<void>();
		vi.mocked(remote.refreshIfStale).mockReturnValue(response.promise);
		const pending = selector.selectExecutor(remoteExecutor.id);
		selector.discardAndClose();
		response.resolve();
		await pending;
		expect(selector.executorId).toBe('local');
		expect(onChange).not.toHaveBeenCalled();
		selector.openDraft();
		await selector.selectExecutor(remoteExecutor.id);
		executors.applySnapshot([localExecutor, { ...remoteExecutor, availability: 'offline' }]);
		selector.selectModel('same');
		expect(onChange).not.toHaveBeenCalled();
	});
});
