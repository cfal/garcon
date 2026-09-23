import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
import { localExecutionNode, remoteExecutionNode } from '$lib/execution-nodes/__tests__/fixtures';
import ComposerExecutionNotice from '../ComposerExecutionNotice.svelte';

function fixture() {
	const nodes = new ExecutionNodesStore();
	nodes.applySnapshot([localExecutionNode, remoteExecutionNode]);
	const catalog = {
		isValidated: false, error: null, forceRefresh: vi.fn(async () => {}),
	} satisfies Pick<ModelCatalogStore, 'isValidated' | 'error' | 'forceRefresh'>;
	return { nodes, catalog };
}

describe('ComposerExecutionNotice', () => {
	it('distinguishes a removed node from a configured offline node and retains its ID', async () => {
		const { nodes, catalog } = fixture();
		nodes.applySnapshot([localExecutionNode, { ...remoteExecutionNode, availability: 'offline' }]);
		render(ComposerExecutionNotice, { nodeId: remoteExecutionNode.id, nodes, catalog });
		expect(screen.getByRole('status').textContent).toContain('Worker is unavailable.');
		nodes.applySnapshot([localExecutionNode]);
		await screen.findByText("This chat's execution node is no longer configured.");
		expect(screen.getByRole('status').getAttribute('title')).toBe(remoteExecutionNode.id);
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});

	it('shows loading and retry only for a ready node with an unvalidated catalog', async () => {
		const { nodes, catalog } = fixture();
		const view = render(ComposerExecutionNotice, { nodeId: remoteExecutionNode.id, nodes, catalog });
		expect(screen.getByRole('status').textContent).toContain('Loading models...');
		await view.rerender({ catalog: { ...catalog, error: 'Synthetic catalog failure' } });
		expect(screen.getByRole('status').textContent).toContain('Synthetic catalog failure');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(catalog.forceRefresh).toHaveBeenCalledOnce();
		await view.rerender({ catalog: { ...catalog, isValidated: true } });
		expect(screen.queryByRole('status')).toBeNull();
	});
});
