import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import ComposerExecutionNotice from '../ComposerExecutionNotice.svelte';

function fixture() {
	const executors = new ExecutorsStore();
	executors.applySnapshot([localExecutor, remoteExecutor]);
	const catalog = {
		isValidated: false, error: null, forceRefresh: vi.fn(async () => {}),
	} satisfies Pick<ModelCatalogStore, 'isValidated' | 'error' | 'forceRefresh'>;
	return { executors, catalog };
}

describe('ComposerExecutionNotice', () => {
	it('distinguishes a removed executor from a configured offline executor and retains its ID', async () => {
		const { executors, catalog } = fixture();
		executors.applySnapshot([localExecutor, { ...remoteExecutor, availability: 'offline' }]);
		render(ComposerExecutionNotice, { executorId: remoteExecutor.id, executors, catalog });
		expect(screen.getByRole('status').textContent).toContain('Worker is unavailable.');
		executors.applySnapshot([localExecutor]);
		await screen.findByText("This chat's executor is no longer configured.");
		expect(screen.getByRole('status').getAttribute('title')).toBe(remoteExecutor.id);
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});

	it('stays silent while models load and offers retry only for a failed catalog', async () => {
		const { executors, catalog } = fixture();
		const view = render(ComposerExecutionNotice, {
			executorId: remoteExecutor.id, executors, catalog, providerAvailable: false,
		});
		expect(screen.queryByRole('status')).toBeNull();
		await view.rerender({ catalog: { ...catalog, error: 'Synthetic catalog failure' } });
		expect(screen.getByRole('status').textContent).toContain('Synthetic catalog failure');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(catalog.forceRefresh).toHaveBeenCalledOnce();
		await view.rerender({ catalog: { ...catalog, isValidated: true } });
		expect(screen.getByRole('status').textContent).toContain('The selected provider or model is unavailable on this executor.');
		await view.rerender({ providerAvailable: true });
		expect(screen.queryByRole('status')).toBeNull();
	});
});
