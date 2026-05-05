import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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

	it('renders a bounded unfiltered model catalog slice', async () => {
		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const listbox = await screen.findByRole('listbox', { name: 'Model' });

		expect(within(listbox).getByText('Model 0')).toBeTruthy();
		expect(within(listbox).queryByText('Model 119')).toBeNull();
		expect(within(listbox).getAllByRole('option').length).toBeLessThan(40);
	});

	it('renders matching model rows as a single visible label', async () => {
		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const input = await screen.findByPlaceholderText('Filter models...');
		await fireEvent.input(input, { target: { value: 'same-model' } });

		expect(await screen.findAllByText('same-model')).toHaveLength(1);
	});

	it('filters against the full catalog beyond the mounted slice', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			modelCount: 600,
			includeDuplicateModel: false,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const input = await screen.findByPlaceholderText('Filter models...');
		await fireEvent.input(input, { target: { value: 'model-599' } });
		await fireEvent.click(await screen.findByText('Model 599'));

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
				harnessId: 'claude',
				modelValue: 'model-599',
				model: 'model-599',
			}));
		});
	});

	it('selects an offscreen model through keyboard navigation', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			modelCount: 600,
			includeDuplicateModel: false,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const input = await screen.findByPlaceholderText('Filter models...');

		await fireEvent.keyDown(input, { key: 'End' });
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
				harnessId: 'claude',
				modelValue: 'model-599',
				model: 'model-599',
			}));
		});
	});
});
