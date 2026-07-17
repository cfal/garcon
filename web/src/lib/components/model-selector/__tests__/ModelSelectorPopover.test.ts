import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelSelectorPopoverHost from './ModelSelectorPopoverHost.svelte';
import type { ModelSelectorRecentOption } from '../model-selector-types';

let originalMatchMedia: typeof window.matchMedia | undefined;

function clearBitsDismissableLayers(): void {
	(
		globalThis as typeof globalThis & {
			bitsDismissableLayers?: Map<unknown, unknown>;
		}
	).bitsDismissableLayers?.clear();
}

function installMatchMedia(matchesCompact: boolean): void {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: vi.fn((query: string) => ({
			matches:
				query === '(max-width: 639px)' || query === '(max-width: 899px)'
					? matchesCompact
					: false,
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
		expect(
			document.querySelector('[data-popover-content]') ??
				document.querySelector('[data-slot="dialog-content"]'),
		).toBeTruthy();
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	const overlay = document.querySelector('[data-dialog-overlay]');
	const outsideTarget = overlay ?? document.createElement('button');
	if (!overlay) document.body.append(outsideTarget);
	await fireEvent.pointerDown(outsideTarget, {
		button: 0,
		clientX: -1,
		clientY: -1,
		pointerType: 'mouse',
	});
	try {
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
		});
	} finally {
		if (!overlay) outsideTarget.remove();
	}
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
		displayLabel: 'Codex · OpenAI OAuth · Codex Model 1',
		...overrides,
	};
}

function claudeRecent(
	overrides: Partial<ModelSelectorRecentOption> = {},
): ModelSelectorRecentOption {
	return {
		id: 'claude:model-0',
		agentId: 'claude',
		modelValue: 'model-0',
		model: 'model-0',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		agentLabel: 'Claude',
		sourceLabel: 'Claude OAuth',
		modelLabel: 'Model 0',
		displayLabel: 'Claude · Claude OAuth · Model 0',
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

function buttonForText(container: HTMLElement, text: string): HTMLElement {
	const button = within(container).getByText(text).closest('button');
	expect(button).toBeTruthy();
	return button as HTMLElement;
}

describe('ModelSelectorPopover', () => {
	beforeEach(() => {
		clearBitsDismissableLayers();
		originalMatchMedia = window.matchMedia;
		installMatchMedia(false);
	});

	afterEach(() => {
		cleanup();
		clearBitsDismissableLayers();
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

	it('commits normal model selection immediately and closes', async () => {
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
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
		});
	});

	it('stages a desktop generation model until an effort is selected', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0', thinkingMode: 'none' },
			mode: { agent: 'select', source: 'select', surface: 'settings', effort: 'select' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0 .* Default/ }));
		const input = await screen.findByPlaceholderText('Filter models...');
		await fireEvent.input(input, { target: { value: 'model-119' } });
		await fireEvent.click(await screen.findByText('Model 119'));

		expect(onChange).not.toHaveBeenCalled();
		expect(
			screen.getByRole('button', { name: /Ultra Highest available reasoning effort/ }),
		).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: /Max Maximum reasoning depth/ }));

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith({
				agentId: 'claude',
				modelValue: 'model-119',
				model: 'model-119',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
				thinkingMode: 'max',
			});
		});
	});

	it('advances compact generation selection from model to effort', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0', thinkingMode: 'low' },
			mode: { agent: 'select', source: 'select', surface: 'settings', effort: 'select' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0 .* Low/ }));
		await chooseCodexModelInCompactLayout();

		expect(onChange).not.toHaveBeenCalled();
		expect(await screen.findByText('Effort')).toBeTruthy();
		const selectedEffort = screen.getByRole('button', { name: /Low Light reasoning/ });
		await waitFor(() => expect(document.activeElement).toBe(selectedEffort));
		await fireEvent.click(
			screen.getByRole('button', { name: /Ultra Highest available reasoning effort/ }),
		);

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: 'codex',
					modelValue: 'codex-model-0',
					thinkingMode: 'ultra',
				}),
			);
		});
	});

	it('uses the wider compact breakpoint when the effort column is enabled', async () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0', thinkingMode: 'none' },
			mode: { agent: 'select', source: 'select', surface: 'settings', effort: 'select' },
			onChange: vi.fn(),
		});

		await waitFor(() => {
			expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 899px)');
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

	it('uses a non-zooming font size for the compact search input', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'fixed', source: 'hidden', surface: 'composer' },
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		const input = await screen.findByPlaceholderText('Filter models...');

		expect(input.className).toContain('text-[16px]');
		expect(input.className).not.toContain('text-sm');
	});

	it('keeps agent navigation draft-only until a model is selected', async () => {
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

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: 'codex',
					modelValue: 'codex-model-0',
					model: 'codex-model-0',
				}),
			);
		});
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
		});
	});

	it('keeps the trigger display on the committed selection while browsing another agent', async () => {
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'hidden', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));

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

	it('keeps provider source navigation draft-only until a model is selected', async () => {
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

		await waitFor(() => {
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
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
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

	it('hides the desktop provider column for a single agent-managed source', async () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			includeManagedAgent: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		expect(await screen.findByText('Provider')).toBeTruthy();
		expect(document.querySelector('[data-popover-content]')?.getAttribute('class')).toContain(
			'w-[min(50rem,calc(100vw-1rem))]',
		);

		await fireEvent.click(await screen.findByRole('button', { name: 'Amp' }));

		await waitFor(() => {
			expect(screen.queryByText('Provider')).toBeNull();
		});
		expect(document.querySelector('[data-popover-content]')?.getAttribute('class')).toContain(
			'w-[min(50rem,calc(100vw-1rem))]',
		);
		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Amp Smart')).toBeTruthy();
	});

	it('shows desktop checkmarks only on committed model rows', async () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			includeEndpointModel: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(
			screen.getByRole('button', { name: 'Claude' }).querySelector('.lucide-check'),
		).toBeNull();
		expect(
			screen.getByRole('button', { name: 'Claude OAuth' }).querySelector('.lucide-check'),
		).toBeNull();
		let listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(buttonForText(listbox, 'Model 0').querySelector('.lucide-check')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

		listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Codex Model 0')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Codex' }).querySelector('.lucide-check')).toBeNull();
		expect(listbox.querySelector('.lucide-check')).toBeNull();
	});

	it('does not show recent or model checkmarks without a committed model', async () => {
		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: '' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [claudeRecent(), codexRecent()],
			preferRecentsOnOpen: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(
			screen
				.getByRole('button', { name: 'Claude · Claude OAuth · Model 0' })
				.querySelector('.lucide-check'),
		).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Claude' }));

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(listbox).getByText('Model 0')).toBeTruthy();
		expect(listbox.querySelector('.lucide-check')).toBeNull();
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
		expect(recentsButton.querySelector('.lucide-check')).toBeNull();
		expect(screen.queryByRole('listbox', { name: 'Provider' })).toBeNull();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();

		await fireEvent.click(
			screen.getByRole('button', { name: 'Codex · OpenAI OAuth · Codex Model 1' }),
		);

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
			recents: [claudeRecent(), codexRecent()],
			preferRecentsOnOpen: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		const currentRecent = screen.getByRole('button', {
			name: 'Claude · Claude OAuth · Model 0',
		});
		expect(
			screen.getByRole('button', { name: 'Codex · OpenAI OAuth · Codex Model 1' }),
		).toBeTruthy();
		expect(currentRecent.querySelector('.lucide-check')).toBeTruthy();
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
		expect(document.querySelector('[data-popover-content]')).toBeNull();
		const contentClass = document
			.querySelector('[data-slot="dialog-content"]')
			?.getAttribute('class');
		expect(contentClass).toContain('top-[var(--app-viewport-center-y)]');
		expect(contentClass).toContain('left-[50%]');
		expect(contentClass).toContain('translate-x-[-50%]');
		expect(contentClass).toContain('translate-y-[-50%]');
		expect(contentClass).toContain('w-[calc(100vw-1rem)]');
		expect(contentClass).toContain('h-[min(32rem,calc(var(--app-height)-1rem))]');
		expect(contentClass).toContain('overflow-hidden');
		expect(contentClass).toContain('p-0');
		expect(contentClass).not.toContain('top-auto');
		expect(contentClass).not.toContain('bottom-0');
		expect(contentClass).not.toContain('max-h-(--bits-popover-content-available-height)');
		const initialListbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(within(initialListbox).getByText('Model 0')).toBeTruthy();
		expect(buttonForText(initialListbox, 'Model 0').querySelector('.lucide-check')).toBeTruthy();
		const header = document.querySelector('[data-slot="model-selector-compact"] header');
		const footer = document.querySelector('[data-slot="model-selector-compact-footer"]');
		expect(header).toBeTruthy();
		expect(footer).toBeTruthy();
		expect(within(header as HTMLElement).queryByRole('button', { name: 'Back' })).toBeNull();
		expect(within(footer as HTMLElement).getByRole('button', { name: 'Back' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		expect(screen.getByText('Claude Providers')).toBeTruthy();
		expect(document.querySelector('[data-slot="model-selector-compact-subtitle"]')).toBeNull();
		expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
		const providerButton = screen.getByRole('button', { name: 'Claude OAuth' });
		expect(providerButton.getAttribute('class')).toContain('px-2');
		expect(providerButton.querySelector('.lucide-check')).toBeNull();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		expect(screen.getByText('Agent')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
		const agentButton = screen.getByRole('button', { name: 'Codex' });
		expect(agentButton.getAttribute('class')).toContain('px-2');
		expect(agentButton.querySelector('.lucide-check')).toBeNull();
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
			await screen.findByRole('button', { name: 'Codex · OpenAI OAuth · Codex Model 1' }),
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
			recents: [claudeRecent(), codexRecent()],
			preferRecentsOnOpen: true,
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Claude · Claude OAuth · Model 0' }).getAttribute('class'),
		).toContain('px-2');
		expect(
			screen
				.getByRole('button', { name: 'Claude · Claude OAuth · Model 0' })
				.querySelector('.lucide-check'),
		).toBeTruthy();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Recents' }));

		expect(
			screen
				.getByRole('button', { name: 'Claude · Claude OAuth · Model 0' })
				.querySelector('.lucide-check'),
		).toBeTruthy();

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Codex · OpenAI OAuth · Codex Model 1' }),
		);

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'codex',
				modelValue: 'codex-model-1',
				model: 'codex-model-1',
			}),
		);
	});

	it('keeps compact recent checkmark after returning from the menu for endpoint recents', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'endpoint-model', modelEndpointId: 'acme-claude' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [endpointRecent(), codexRecent()],
			preferRecentsOnOpen: true,
			includeEndpointModel: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Endpoint Model/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		const currentRecent = screen.getByRole('button', { name: 'Claude · Acme · Endpoint Model' });
		expect(currentRecent.querySelector('.lucide-check')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Recents' }));

		expect(
			screen
				.getByRole('button', { name: 'Claude · Acme · Endpoint Model' })
				.querySelector('.lucide-check'),
		).toBeTruthy();
	});

	it('keeps compact recent checkmark after draft agent and provider navigation', async () => {
		installMatchMedia(true);

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'codex', model: 'codex-model-1' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			recents: [codexRecent(), endpointRecent()],
			preferRecentsOnOpen: true,
			includeEndpointModel: true,
			onChange: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: /Codex .* Codex Model 1/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(
			screen
				.getByRole('button', { name: 'Codex · OpenAI OAuth · Codex Model 1' })
				.querySelector('.lucide-check'),
		).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Claude' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
		expect(await screen.findByRole('listbox', { name: 'Model' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Recents' }));

		expect(
			screen
				.getByRole('button', { name: 'Codex · OpenAI OAuth · Codex Model 1' })
				.querySelector('.lucide-check'),
		).toBeTruthy();
	});

	it('commits compact model selection immediately', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await chooseCodexModelInCompactLayout();

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: 'codex',
					modelValue: 'codex-model-0',
					model: 'codex-model-0',
				}),
			);
		});
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
		});
	});

	it('keeps compact Done disabled while agent navigation has no selected model', async () => {
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
	});

	it('discards compact navigation from Cancel or outside close', async () => {
		installMatchMedia(true);
		const onChange = vi.fn();

		render(ModelSelectorPopoverHost, {
			value: { agentId: 'claude', model: 'model-0' },
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			onChange,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Codex' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Claude .* Model 0/ })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Model 0/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Codex' }));
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

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: 'claude',
					modelValue: 'model-599',
					model: 'model-599',
				}),
			);
		});
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
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

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: 'claude',
					modelValue: 'model-599',
					model: 'model-599',
				}),
			);
		});
		await waitFor(() => {
			expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
		});
	});
});
