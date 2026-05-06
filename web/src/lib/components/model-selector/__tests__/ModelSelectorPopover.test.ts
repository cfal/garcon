import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ModelSelectorPopoverHarness from './ModelSelectorPopoverHarness.svelte';

async function closePopoverByOutsideClick(): Promise<void> {
	await waitFor(() => {
		expect(document.querySelector('[data-popover-content]')).toBeTruthy();
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	await fireEvent.pointerDown(document.body, {
		button: 0,
		clientX: 100,
		clientY: 100,
		pointerType: 'mouse',
	});
	await fireEvent.click(document.body, { clientX: 100, clientY: 100 });
	await waitFor(() => {
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
	});
}

describe('ModelSelectorPopover', () => {
	it('keeps the popup open after model selection and commits the draft on outside close', async () => {
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

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('listbox', { name: 'Model' })).toBeTruthy();

		await closePopoverByOutsideClick();

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

	it('switches the open harness view without committing until the popup closes', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'select', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));

		expect(onChange).not.toHaveBeenCalled();

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Codex Model 0')).toBeTruthy();
		expect(within(listbox).queryByText('Model 0')).toBeNull();

		await fireEvent.click(within(listbox).getByText('Codex Model 0'));

		expect(onChange).not.toHaveBeenCalled();

		await closePopoverByOutsideClick();

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
			harnessId: 'codex',
			modelValue: 'codex-model-0',
			model: 'codex-model-0',
		}));
	});

	it('commits the fallback model when a draft harness change closes', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'select', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));

		await closePopoverByOutsideClick();

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
			harnessId: 'codex',
			modelValue: 'codex-model-0',
			model: 'codex-model-0',
		}));
	});

	it('keeps provider source and model changes draft-only until the popup closes', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'fixed', source: 'select', surface: 'settings' },
			includeEndpointModel: true,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));

		expect(onChange).not.toHaveBeenCalled();

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Endpoint Model')).toBeTruthy();

		await fireEvent.click(within(listbox).getByText('Endpoint Model'));

		expect(onChange).not.toHaveBeenCalled();

		await closePopoverByOutsideClick();

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({
			harnessId: 'claude',
			modelValue: 'acme-claude:endpoint-model',
			model: 'endpoint-model',
			apiProviderId: 'acme',
			modelEndpointId: 'acme-claude',
			modelProtocol: 'anthropic-messages',
		});
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

		expect(onChange).not.toHaveBeenCalled();

		await closePopoverByOutsideClick();

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

		expect(onChange).not.toHaveBeenCalled();

		await closePopoverByOutsideClick();

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
				harnessId: 'claude',
				modelValue: 'model-599',
				model: 'model-599',
			}));
		});
	});
});
