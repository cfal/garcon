import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogStore, type AgentMetadata } from '$lib/agents/model-catalog-store.svelte';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
import { localExecutionNode, remoteExecutionNode } from '$lib/execution-nodes/__tests__/fixtures';
import { ModelSelectorState } from '../model-selector-state.svelte';
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

function fixture(remoteAgent = 'sample', node: 'fixed' | 'select' = 'select') {
	const nodes = new ExecutionNodesStore();
	nodes.applySnapshot([localExecutionNode, remoteExecutionNode]);
	const catalog = new ModelCatalogStore();
	const remote = catalog.forNode(remoteExecutionNode.id);
	catalog.agentMetadata = { sample: metadata('sample') };
	catalog.agentModels = { sample: [{ value: 'same', label: 'Local model' }] };
	remote.agentMetadata = { [remoteAgent]: metadata(remoteAgent) };
	remote.agentModels = { [remoteAgent]: [{ value: 'same', label: 'Worker model' }] };
	vi.spyOn(catalog, 'refreshIfStale').mockResolvedValue();
	vi.spyOn(remote, 'refreshIfStale').mockResolvedValue();
	const onChange = vi.fn();
	const selector = new ModelSelectorState({
		modelCatalog: catalog, nodes, value: { nodeId: 'local', agentId: 'sample', model: 'same' },
		mode: { node, agent: 'select', source: 'select', surface: 'composer' },
		getRecents: (nodeId) => buildModelSelectorRecents(catalog.forNode(nodeId), [
			{ agentId: 'sample', model: 'same', apiProviderId: null, modelEndpointId: null, modelProtocol: null },
			{ nodeId: remoteExecutionNode.id, agentId: remoteAgent, model: 'same', apiProviderId: null, modelEndpointId: null, modelProtocol: null },
		]),
		preferRecentsOnOpen: false, onChange,
		getSelectableAgentIds: (nodeId) => catalog.forNode(nodeId).getSelectableAgents(),
	});
	return { selector, nodes, catalog, remote, onChange };
}

describe('model selector node selection', () => {
	beforeEach(() => localStorage.clear());

	it('fixed-node selection and recents cannot change hosts', async () => {
		const { selector, catalog, onChange } = fixture('sample', 'fixed');
		selector.openDraft();
		expect(selector.showNodePicker).toBe(false);
		await selector.selectNode(remoteExecutionNode.id);
		expect(selector.nodeId).toBe('local');
		const recent = buildModelSelectorRecents(catalog.forNode(remoteExecutionNode.id), [{
			nodeId: remoteExecutionNode.id, agentId: 'sample', model: 'same', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
		}])[0]!;
		selector.selectRecent(recent);
		expect(onChange).not.toHaveBeenCalled();
	});

	it('keeps node browsing draft-only and commits the same model name on another node', async () => {
		const { selector, onChange } = fixture();
		selector.openDraft();
		expect(selector.modelRows[0]?.label).toBe('Local model');
		expect(selector.recentOptions.map((recent) => recent.modelLabel)).toEqual(['Local model']);
		await selector.selectNode(remoteExecutionNode.id);
		expect(onChange).not.toHaveBeenCalled();
		expect(selector.committedNodeId).toBe('local');
		expect(selector.nodeId).toBe(remoteExecutionNode.id);
		expect(selector.triggerTitle).toContain('Local');
		expect(selector.triggerTitle).toContain('Local model');
		expect(selector.modelRows[0]?.label).toBe('Worker model');
		expect(selector.recentOptions.map((recent) => recent.modelLabel)).toEqual(['Worker model']);
		selector.selectModel('same');
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ nodeId: remoteExecutionNode.id, agentId: 'sample', model: 'same' }));
	});

	it('uses destination inventory rather than filtering it through the source inventory', async () => {
		const { selector, onChange } = fixture('remote-only');
		selector.openDraft();
		await selector.selectNode(remoteExecutionNode.id);
		expect(selector.selectableAgentIds).toEqual(['remote-only']);
		expect(selector.agentId).toBe('remote-only');
		selector.selectModel('same');
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ nodeId: remoteExecutionNode.id, agentId: 'remote-only' }));
	});

	it('discards a pending node selection on close and rejects offline commits', async () => {
		const { selector, nodes, remote, onChange } = fixture();
		selector.openDraft();
		const response = Promise.withResolvers<void>();
		vi.mocked(remote.refreshIfStale).mockReturnValue(response.promise);
		const pending = selector.selectNode(remoteExecutionNode.id);
		selector.discardAndClose();
		response.resolve();
		await pending;
		expect(selector.nodeId).toBe('local');
		expect(onChange).not.toHaveBeenCalled();
		selector.openDraft();
		await selector.selectNode(remoteExecutionNode.id);
		nodes.applySnapshot([localExecutionNode, { ...remoteExecutionNode, availability: 'offline' }]);
		selector.selectModel('same');
		expect(onChange).not.toHaveBeenCalled();
	});
});
