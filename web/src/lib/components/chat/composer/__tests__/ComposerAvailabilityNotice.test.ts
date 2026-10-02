import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ComposerAvailabilityNotice from '../ComposerAvailabilityNotice.svelte';

function callbacks() {
	return {
		onRetryProject: vi.fn(),
		onChooseProjectFolder: vi.fn(),
		onRetryCatalog: vi.fn(),
	};
}

describe('ComposerAvailabilityNotice', () => {
	it('offers Retry for a failed model catalog in the shared notice card', async () => {
		const actions = callbacks();
		const { container } = render(ComposerAvailabilityNotice, {
			notice: { kind: 'catalog-failed', message: 'Failed to fetch model catalog: 502' },
			...actions,
		});
		const card = container.querySelector('[data-composer-availability-notice="catalog-failed"]');
		expect(card?.className).toContain('rounded-lg');
		expect(card?.hasAttribute('data-project-availability-notice')).toBe(false);
		expect(screen.getByText('Failed to load model catalog')).toBeTruthy();
		expect(screen.getByRole('status').textContent).toContain('Failed to fetch model catalog: 502');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(actions.onRetryCatalog).toHaveBeenCalledOnce();
		expect(actions.onRetryProject).not.toHaveBeenCalled();
	});

	it('keeps project recovery actions and the project notice marker', async () => {
		const actions = callbacks();
		const { container } = render(ComposerAvailabilityNotice, {
			notice: { kind: 'project-unavailable', projectPath: '/workspace/missing', reason: 'not-found' },
			...actions,
		});
		expect(container.querySelector('[data-project-availability-notice]')).toBeTruthy();
		expect(screen.getByText('Project folder unavailable')).toBeTruthy();
		expect(screen.getByText('/workspace/missing')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
		expect(actions.onRetryProject).toHaveBeenCalledOnce();
		expect(actions.onChooseProjectFolder).toHaveBeenCalledOnce();
		expect(actions.onRetryCatalog).not.toHaveBeenCalled();
	});

	it('explains executor and provider obstacles without offering unusable actions', async () => {
		const view = render(ComposerAvailabilityNotice, {
			notice: { kind: 'executor-removed', executorId: 'synthetic-executor-id' },
			...callbacks(),
		});
		expect(screen.getByText('Executor unavailable')).toBeTruthy();
		expect(screen.getByText("This chat's executor is no longer configured.")).toBeTruthy();
		expect(screen.getByText('synthetic-executor-id')).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();

		await view.rerender({ notice: { kind: 'executor-unavailable', executorLabel: 'Worker' } });
		expect(screen.getByText('Worker is unavailable.')).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();

		await view.rerender({ notice: { kind: 'provider-unavailable' } });
		expect(screen.getByText('Model unavailable')).toBeTruthy();
		expect(
			screen.getByText('The selected provider or model is unavailable on this executor.'),
		).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
	});
});
