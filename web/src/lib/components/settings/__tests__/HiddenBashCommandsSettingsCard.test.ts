import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HiddenBashCommandsSettingsCardTestHost from './HiddenBashCommandsSettingsCardTestHost.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import {
	updateRemoteSettings,
	type UpdateRemoteSettingsResponse,
} from '$lib/api/settings.js';
import { setTestRemoteSettingsStore } from './remote-settings-test-context';
import {
	makeRemoteSettingsSnapshot,
	mockRemoteSettingsUpdate,
} from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import {
	HIDDEN_BASH_COMMAND_PATTERN_PRESETS,
	type HiddenBashCommandPattern,
} from '$lib/chat/transcript/hidden-bash-commands.js';

vi.mock('$lib/api/settings.js', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

function renderCard(patterns: HiddenBashCommandPattern[] = []): RemoteSettingsStore {
	const store = new RemoteSettingsStore();
	store.applySnapshot(
		makeRemoteSettingsSnapshot({ ui: { hiddenBashCommandPatterns: patterns } }),
	);
	setTestRemoteSettingsStore(store);
	mockRemoteSettingsUpdate(store);
	render(HiddenBashCommandsSettingsCardTestHost);
	return store;
}

async function enterPattern(pattern: string, mode: 'regex' | 'glob' = 'glob'): Promise<void> {
	await fireEvent.input(screen.getByLabelText('Command pattern'), { target: { value: pattern } });
	const modeSelect = screen.getByLabelText('Pattern type') as HTMLSelectElement;
	if (modeSelect.value !== mode) {
		await fireEvent.change(modeSelect, { target: { value: mode } });
	}
}

async function selectGarconAmpPreset(): Promise<void> {
	await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
	await fireEvent.click(screen.getByRole('button', { name: 'Add preset' }));
	await fireEvent.click(screen.getByRole('menuitem', { name: 'Garcon-amp rules' }));
}

describe('HiddenBashCommandsSettingsCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	it('adds the full pattern list remotely through the shared submit path', async () => {
		renderCard([{ pattern: '^cargo', mode: 'regex' }]);
		await enterPattern('git *');

		await fireEvent.submit(screen.getByRole('button', { name: 'Add' }).closest('form')!);

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: {
					hiddenBashCommandPatterns: [
						{ pattern: '^cargo', mode: 'regex' },
						{ pattern: 'git *', mode: 'glob' },
					],
				},
			});
			expect(screen.getByText('git *')).toBeTruthy();
		});
		expect(localStorage.length).toBe(0);
	});

	it('adds a regex pattern when regex mode is selected', async () => {
		renderCard();
		await enterPattern('^cargo', 'regex');
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));

		await waitFor(() => expect(screen.getByText('^cargo')).toBeTruthy());
		expect(
			within(screen.getByTestId('hidden-bash-command-patterns')).getByText('Regex'),
		).toBeTruthy();
	});

	it('adds only missing preset entries', async () => {
		const [, relativePattern] = HIDDEN_BASH_COMMAND_PATTERN_PRESETS[0].patterns;
		renderCard([
			{ pattern: 'manual *', mode: 'glob' },
			{ ...relativePattern },
		]);

		await selectGarconAmpPreset();
		await waitFor(() => expect(updateRemoteSettings).toHaveBeenCalledTimes(1));

		expect(updateRemoteSettings).toHaveBeenCalledTimes(1);
		expect(vi.mocked(updateRemoteSettings).mock.calls[0]?.[0].ui?.hiddenBashCommandPatterns).toEqual([
			{ pattern: 'manual *', mode: 'glob' },
			{ ...relativePattern },
			{ ...HIDDEN_BASH_COMMAND_PATTERN_PRESETS[0].patterns[0] },
		]);
	});

	it('skips a preset when every entry is already present', async () => {
		renderCard(HIDDEN_BASH_COMMAND_PATTERN_PRESETS[0].patterns.map((entry) => ({ ...entry })));

		await selectGarconAmpPreset();

		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('rejects invalid patterns without sending a request', async () => {
		renderCard();

		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.getByRole('alert').textContent).toBe('Enter a pattern');

		await enterPattern('x'.repeat(1_001));
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.getByRole('alert').textContent).toContain('at most 1000 characters');

		await enterPattern('([unclosed', 'regex');
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.getByRole('alert').textContent).toBe('Invalid regular expression');

		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('rejects an exact duplicate without sending a request', async () => {
		renderCard([{ pattern: 'git *', mode: 'glob' }]);
		await enterPattern('git *');
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));

		expect(screen.getByRole('alert').textContent).toBe('This pattern is already hidden');
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('rejects a manual entry when the list is full', async () => {
		renderCard(
			Array.from({ length: 200 }, (_, index) => ({
				pattern: `command-${index}`,
				mode: 'glob',
			})),
		);
		await enterPattern('one more');
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));

		expect(screen.getByRole('alert').textContent).toContain('at most 200');
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('rejects a preset that would exceed the list limit', async () => {
		renderCard(
			Array.from({ length: 199 }, (_, index) => ({
				pattern: `command-${index}`,
				mode: 'glob',
			})),
		);
		await selectGarconAmpPreset();

		expect(screen.getByRole('alert').textContent).toContain('at most 200');
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('removes a pattern by persisting the remaining full list', async () => {
		renderCard([
			{ pattern: 'git *', mode: 'glob' },
			{ pattern: '^cargo', mode: 'regex' },
		]);

		await fireEvent.click(
			screen.getByRole('button', { name: 'Remove pattern: git * (Glob)' }),
		);

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: { hiddenBashCommandPatterns: [{ pattern: '^cargo', mode: 'regex' }] },
			});
			expect(screen.queryByText('git *')).toBeNull();
		});
	});

	it('retains the canonical list and draft after a request failure', async () => {
		renderCard([{ pattern: 'git *', mode: 'glob' }]);
		vi.mocked(updateRemoteSettings).mockRejectedValueOnce(new Error('Server unavailable'));
		await enterPattern('cargo *');

		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));

		expect((await screen.findByRole('alert')).textContent).toBe('Server unavailable');
		expect(screen.getAllByRole('alert')).toHaveLength(1);
		expect(screen.getByText('git *')).toBeTruthy();
		expect(screen.queryByText('cargo *')).toBeNull();
		expect((screen.getByLabelText('Command pattern') as HTMLInputElement).value).toBe('cargo *');
		expect(screen.getByLabelText('Command pattern').getAttribute('aria-invalid')).toBe('false');
	});

	it('keeps input focus and disables mutation controls while saving', async () => {
		const store = renderCard([{ pattern: 'git *', mode: 'glob' }]);
		let resolveUpdate!: (response: UpdateRemoteSettingsResponse) => void;
		vi.mocked(updateRemoteSettings).mockImplementationOnce(
			() => new Promise((resolve) => (resolveUpdate = resolve)),
		);
		await enterPattern('cargo *');
		const patternInput = screen.getByLabelText('Command pattern') as HTMLInputElement;
		patternInput.focus();

		await fireEvent.submit(screen.getByRole('button', { name: 'Add' }).closest('form')!);

		expect(patternInput.readOnly).toBe(true);
		expect(document.activeElement).toBe(patternInput);
		expect((screen.getByLabelText('Pattern type') as HTMLSelectElement).disabled).toBe(true);
		expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole('button', { name: 'Add preset' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(
			(screen.getByRole('button', {
				name: 'Remove pattern: git * (Glob)',
			}) as HTMLButtonElement).disabled,
		).toBe(true);

		resolveUpdate({
			success: true,
			settings: makeRemoteSettingsSnapshot({
				version: (store.snapshot?.version ?? 1) + 1,
				ui: {
					hiddenBashCommandPatterns: [
						{ pattern: 'git *', mode: 'glob' },
						{ pattern: 'cargo *', mode: 'glob' },
					],
				},
			}),
		});
		await waitFor(() =>
			expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(
				false,
			),
		);
		expect(patternInput.readOnly).toBe(false);
		expect(document.activeElement).toBe(patternInput);
	});

	it('keeps controls touch-friendly and removal labels distinct', () => {
		renderCard([
			{ pattern: 'git *', mode: 'glob' },
			{ pattern: '^git', mode: 'regex' },
		]);

		expect(screen.getByLabelText('Command pattern').className).toContain('text-base');
		expect(screen.getByLabelText('Pattern type').className).toContain('text-base');
		expect(screen.getByRole('button', { name: 'Remove pattern: git * (Glob)' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Remove pattern: ^git (Regex)' })).toBeTruthy();
	});
});
