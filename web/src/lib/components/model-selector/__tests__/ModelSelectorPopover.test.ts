import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelSelectorPopoverHarness from './ModelSelectorPopoverHarness.svelte';

let originalMatchMedia: typeof window.matchMedia | undefined;

function installMatchMedia(matchesCompact: boolean): void {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: vi.fn((query: string) => ({
			matches: query === '(max-width: 639px)' ? matchesCompact : false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	});
}

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

async function chooseCodexModelInCompactLayout(): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
	await fireEvent.click(await screen.findByRole('button', { name: 'Codex' }));
	await fireEvent.click(screen.getByRole('button', { name: 'OpenAI OAuth' }));
	await fireEvent.click(await screen.findByText('Codex Model 0'));
}

describe('ModelSelectorPopover', () => {
	beforeEach(() => {
		originalMatchMedia = window.matchMedia;
		installMatchMedia(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalMatchMedia) {
			Object.defineProperty(window, 'matchMedia', {
				configurable: true,
				writable: true,
				value: originalMatchMedia,
			});
		} else {
			Reflect.deleteProperty(window, 'matchMedia');
		}
	});

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

	it('keeps the trigger display on the committed selection while editing a draft', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'select', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));
		await fireEvent.click(await screen.findByText('Codex Model 0'));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Claude .* Model 0/ })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Codex .* Codex Model 0/ })).toBeNull();
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

	it('reserves the trigger subtitle row when the committed subtitle is empty', () => {
		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: '' },
			mode: { harness: 'fixed', source: 'hidden', surface: 'settings' },
			modelCount: 0,
			includeDuplicateModel: false,
			onChange: vi.fn(),
		});

		const subtitle = document.querySelector('[data-slot="model-selector-trigger-secondary"]');

		expect(subtitle).toBeTruthy();
		expect(subtitle?.textContent).toBe('');
		expect(subtitle?.getAttribute('aria-hidden')).toBe('true');
	});

	it('uses a compact drill-down layout on narrow screens starting from the selected model', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'select', source: 'select', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(document.querySelector('[data-slot="model-selector-compact"]')).toBeTruthy();
		const initialListbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(initialListbox).getByText('Model 0')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		expect(screen.getByText('Claude Providers')).toBeTruthy();
		expect(document.querySelector('[data-slot="model-selector-compact-subtitle"]')).toBeNull();
		expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Claude OAuth' })).toBeTruthy();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		expect(screen.getByText('Harness')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Codex' })).toBeTruthy();
	});

	it('starts compact selection at harness when no model is selected', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: '' },
			mode: { harness: 'select', source: 'select', surface: 'composer' },
			modelCount: 0,
			includeDuplicateModel: false,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude/ }));

		expect(screen.getByText('Harness')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
	});

	it('commits compact draft selection only from Done', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'select', source: 'select', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await chooseCodexModelInCompactLayout();

		expect(onChange).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
			harnessId: 'codex',
			modelValue: 'codex-model-0',
			model: 'codex-model-0',
		}));
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
		});
	});

	it('discards compact draft selection from Cancel or outside close', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHarness, {
			value: { harnessId: 'claude', model: 'model-0' },
			mode: { harness: 'select', source: 'select', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await chooseCodexModelInCompactLayout();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Claude .* Model 0/ })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await chooseCodexModelInCompactLayout();
		await closePopoverByOutsideClick();

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Claude .* Model 0/ })).toBeTruthy();
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
