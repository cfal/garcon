import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ModelSelectorPopoverHarness from './ModelSelectorPopoverHarness.svelte';

describe('ModelSelectorPopover', () => {
	it('filters model-only composer selections and emits selected model values', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const input = await screen.findByPlaceholderText('Filter models...');
		await fireEvent.input(input, { target: { value: 'model-119' } });
		await fireEvent.click(await screen.findByText('Model 119'));

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith({
				harnessId: 'claude',
				modelValue: 'model-119',
				model: 'model-119',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			});
		});
	});

	it('renders the full unfiltered model catalog', async () => {
		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findByText('Model 99')).toBeTruthy();
		expect(screen.getByText('Model 100')).toBeTruthy();
		expect(screen.getByText('Model 119')).toBeTruthy();
	});

	it('hides model subtitles that duplicate the visible model label', async () => {
		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findAllByText('same-model')).toHaveLength(1);
	});
});
