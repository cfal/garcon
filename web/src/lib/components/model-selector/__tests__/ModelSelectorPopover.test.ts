import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelSelectorPopoverHost from './ModelSelectorPopoverHost.svelte';
import type { ModelSelectorRecentOption } from '../model-selector-types';

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
	await fireEvent.click(await screen.findByRole('button', { name: 'Codex' }));
	await fireEvent.click(await screen.findByText('Codex Model 0'));
}

function codexRecent(
	overrides: Partial<ModelSelectorRecentOption> = {},
): ModelSelectorRecentOption {
	return {
		id: 'codex:gpt-5',
		agentId: 'codex',
		modelValue: 'codex-model-1',
		model: 'codex-model-1',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		agentLabel: 'Codex',
		sourceLabel: 'OpenAI',
		modelLabel: 'Codex Model 1',
		displayLabel: 'Codex · OpenAI · Codex Model 1',
		...overrides,
	};
}

function endpointRecent(): ModelSelectorRecentOption {
	return codexRecent({
		id: 'claude:acme:endpoint-model',
		agentId: 'claude',
		modelValue: 'acme-claude:endpoint-model',
		model: 'endpoint-model',
		apiProviderId: 'acme',
		modelEndpointId: 'acme-claude',
		modelProtocol: 'anthropic-messages',
		agentLabel: 'Claude',
		sourceLabel: 'Acme',
		modelLabel: 'Endpoint Model',
		displayLabel: 'Claude · Acme · Endpoint Model',
	});
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

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'hidden', surface: 'composer' },
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
				agentId: 'claude',
				modelValue: 'model-119',
				model: 'model-119',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			});
		});
	});

	it('renders a bounded unfiltered model catalog slice', async () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'hidden', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const listbox = await screen.findByRole('listbox', { name: 'Model' });

		expect(within(listbox).getByText('Model 0')).toBeTruthy();
		expect(within(listbox).queryByText('Model 119')).toBeNull();
		expect(within(listbox).getAllByRole('option').length).toBeLessThan(40);
	});

	it('switches the open agent view without committing until the popup closes', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));

		expect(onChange).not.toHaveBeenCalled();

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Codex Model 0')).toBeTruthy();
		expect(within(listbox).queryByText('Model 0')).toBeNull();
		expect(listbox.querySelector('.lucide-check')).toBeNull();

		await fireEvent.click(within(listbox).getByText('Codex Model 0'));

		expect(onChange).not.toHaveBeenCalled();

		await closePopoverByOutsideClick();

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'codex',
				modelValue: 'codex-model-0',
				model: 'codex-model-0',
			}),
		);
	});

	it('keeps the trigger display on the committed selection while editing a draft', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));
		await fireEvent.click(await screen.findByText('Codex Model 0'));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Claude .* Model 0/ })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Codex .* Codex Model 0/ })).toBeNull();
	});

	it('does not commit agent navigation without a model selection', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));

		await closePopoverByOutsideClick();

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Claude .* Model 0/ })).toBeTruthy();
	});

	it('keeps provider source and model changes draft-only until the popup closes', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'select', surface: 'settings' },
			includeEndpointModel: true,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));

		expect(onChange).not.toHaveBeenCalled();

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Endpoint Model')).toBeTruthy();
		expect(listbox.querySelector('.lucide-check')).toBeNull();

		await fireEvent.click(within(listbox).getByText('Endpoint Model'));

		expect(onChange).not.toHaveBeenCalled();

		await closePopoverByOutsideClick();

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({
			agentId: 'claude',
			modelValue: 'acme-claude:endpoint-model',
			model: 'endpoint-model',
			apiProviderId: 'acme',
			modelEndpointId: 'acme-claude',
			modelProtocol: 'anthropic-messages',
		});
	});

	it('does not commit provider navigation without a model selection', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'select', surface: 'settings' },
			includeEndpointModel: true,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Endpoint Model')).toBeTruthy();
		expect(listbox.querySelector('.lucide-check')).toBeNull();

		await closePopoverByOutsideClick();

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Claude .* Model 0/ })).toBeTruthy();
	});

	it('renders desktop recents above the agent header and commits a recent immediately', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [codexRecent()],
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const recentsButton = await screen.findByRole('button', { name: 'Recents' });
		const agentHeader = screen.getByText('Agent');

		expect(
			recentsButton.compareDocumentPosition(agentHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		await fireEvent.click(recentsButton);

		expect(screen.getByText('Recent models')).toBeTruthy();
		expect(screen.queryByRole('listbox', { name: 'Provider' })).toBeNull();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Codex · OpenAI · Codex Model 1' }));

		expect(onChange).toHaveBeenCalledWith({
			agentId: 'codex',
			modelValue: 'codex-model-1',
			model: 'codex-model-1',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		});
		await waitFor(() => {
			expect(screen.queryByText('Recent models')).toBeNull();
		});
	});

	it('opens desktop selection at recents when requested with multiple recents', async () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [codexRecent(), endpointRecent()],
			preferRecentsOnOpen: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Codex · OpenAI · Codex Model 1' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Claude · Acme · Endpoint Model' })).toBeTruthy();
		expect(screen.queryByRole('listbox', { name: 'Provider' })).toBeNull();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
	});

	it('keeps desktop selection on the selected model when only one recent exists', async () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [codexRecent()],
			preferRecentsOnOpen: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Model 0')).toBeTruthy();
		expect(screen.queryByText('Recent models')).toBeNull();
	});

	it('preserves endpoint metadata when committing a recent', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [endpointRecent()],
			includeEndpointModel: true,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Recents' }));
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Claude · Acme · Endpoint Model' }),
		);

		expect(onChange).toHaveBeenCalledWith({
			agentId: 'claude',
			modelValue: 'acme-claude:endpoint-model',
			model: 'endpoint-model',
			apiProviderId: 'acme',
			modelEndpointId: 'acme-claude',
			modelProtocol: 'anthropic-messages',
		});
	});

	it('reserves the trigger subtitle row when the committed subtitle is empty', () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: '' },
			mode: { agent: 'fixed', source: 'hidden', surface: 'settings' },
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

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			includeEndpointModel: true,
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

		expect(screen.getByText('Agent')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Codex' })).toBeTruthy();
	});

	it('skips the compact provider pane when the selected agent has one provider', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findByRole('listbox', { name: 'Model' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		expect(screen.getByText('Agent')).toBeTruthy();
		expect(screen.queryByText('Claude Providers')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Codex Model 0')).toBeTruthy();
		expect(screen.queryByText('Codex Providers')).toBeNull();
	});

	it('starts compact selection at agent when no model is selected', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: '' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			modelCount: 0,
			includeDuplicateModel: false,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude/ }));

		expect(screen.getByText('Agent')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
	});

	it('opens compact recents from the top-level menu and commits immediately', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [codexRecent()],
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findByRole('listbox', { name: 'Model' })).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		expect(screen.getByRole('button', { name: 'Codex' })).toBeTruthy();
		await fireEvent.click(await screen.findByRole('button', { name: 'Recents' }));

		expect(screen.getByText('Recent models')).toBeTruthy();
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Codex · OpenAI · Codex Model 1' }),
		);

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'codex',
				modelValue: 'codex-model-1',
				model: 'codex-model-1',
			}),
		);
		await waitFor(() => {
			expect(screen.queryByText('Recent models')).toBeNull();
		});
	});

	it('opens compact selection at recents when requested with multiple recents', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [codexRecent(), endpointRecent()],
			preferRecentsOnOpen: true,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Codex · OpenAI · Codex Model 1' }),
		);

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'codex',
				modelValue: 'codex-model-1',
				model: 'codex-model-1',
			}),
		);
	});

	it('commits compact draft selection only from Done', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await chooseCodexModelInCompactLayout();

		expect(onChange).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'codex',
				modelValue: 'codex-model-0',
				model: 'codex-model-0',
			}),
		);
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
		});
	});

	it('keeps compact Done disabled until a model is selected after navigation', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		const done = screen.getByRole('button', { name: 'Done' });

		expect(within(listbox).getByText('Codex Model 0')).toBeTruthy();
		expect(listbox.querySelector('.lucide-check')).toBeNull();
		expect(done.hasAttribute('disabled')).toBe(true);

		await fireEvent.click(within(listbox).getByText('Codex Model 0'));

		expect(done.hasAttribute('disabled')).toBe(false);
	});

	it('discards compact draft selection from Cancel or outside close', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
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
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'hidden', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const input = await screen.findByPlaceholderText('Filter models...');
		await fireEvent.input(input, { target: { value: 'same-model' } });

		expect(await screen.findAllByText('same-model')).toHaveLength(1);
	});

	it('filters against the full catalog beyond the mounted slice', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'hidden', surface: 'composer' },
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
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: 'claude',
					modelValue: 'model-599',
					model: 'model-599',
				}),
			);
		});
	});

	it('selects an offscreen model through keyboard navigation', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'hidden', surface: 'composer' },
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
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: 'claude',
					modelValue: 'model-599',
					model: 'model-599',
				}),
			);
		});
	});
});
