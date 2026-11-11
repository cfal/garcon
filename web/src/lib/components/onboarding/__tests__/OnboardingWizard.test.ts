import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { updateRemoteSettings } from '$lib/api/settings.js';
import {
	makeRemoteSettingsSnapshot,
	mockRemoteSettingsUpdate,
} from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import { DARK_THEME_PROFILES, LIGHT_THEME_PROFILES } from '$lib/theme/themes.js';

const OnboardingWizardTestHost = (await import('./OnboardingWizardTestHost.svelte')).default;

vi.mock('$lib/api/settings.js', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

async function waitForAnimationFrames(count: number): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	}
}

describe('OnboardingWizard', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	function renderWizard() {
		const appShell = createAppShellStore();
		const localSettings = createLocalSettingsStore();
		const remoteSettings = new RemoteSettingsStore();
		remoteSettings.applySnapshot(makeRemoteSettingsSnapshot());
		mockRemoteSettingsUpdate(remoteSettings);
		appShell.openOnboardingWizard();
		render(OnboardingWizardTestHost, { appShell, localSettings, remoteSettings });
		return { appShell, localSettings, remoteSettings };
	}

	async function advanceToThemePage() {
		await screen.findByRole('heading', { name: 'Welcome to Garcon' });
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Choose your theme' });
	}

	async function visitSearchPage() {
		await advanceToThemePage();
		for (const title of [
			'Arrange your sidebar',
			'Chat display',
			'Writing and behavior',
			'Search your conversations',
		]) {
			await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
			await screen.findByRole('heading', { name: title });
		}
	}

	async function advanceToSearchPage() {
		await visitSearchPage();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false),
		);
	}

	async function advanceToDonePage() {
		await advanceToSearchPage();
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: "What's next" });
		expect(
			screen.getByText('Review your API providers, then put your workspace to work.'),
		).toBeTruthy();
	}

	it('advances through the pages and moves focus to each page heading', async () => {
		renderWizard();

		const welcomeHeading = await screen.findByRole('heading', { name: 'Welcome to Garcon' });
		await waitForAnimationFrames(2);
		await waitFor(() => expect(document.activeElement).toBe(welcomeHeading));
		expect(screen.getByText(/PC in your mom's basement/)).toBeTruthy();
		expect(screen.getByText(/conversations from another computer/)).toBeTruthy();
		expect(updateRemoteSettings).not.toHaveBeenCalled();
		await advanceToThemePage();
		const themeHeading = screen.getByRole('heading', { name: 'Choose your theme' });
		await waitFor(() => expect(document.activeElement).toBe(themeHeading));

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		const layoutHeading = await screen.findByRole('heading', { name: 'Arrange your sidebar' });
		await waitFor(() => expect(document.activeElement).toBe(layoutHeading));

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await screen.findByRole('heading', { name: 'Choose your theme' });
	});

	it('writes theme and display selections to local settings', async () => {
		const { localSettings } = renderWizard();
		await advanceToThemePage();

		await fireEvent.click(screen.getByRole('radio', { name: /Use one theme/ }));
		expect(localSettings.themePreference).toEqual({
			mode: 'fixed',
			themeId: 'phosphor-light',
		});
		await fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), {
			target: { value: 'colorblind-dark' },
		});
		expect(localSettings.themePreference).toEqual({
			mode: 'fixed',
			themeId: 'colorblind-dark',
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Arrange your sidebar' });
		await fireEvent.click(screen.getByRole('radio', { name: /Single line/ }));
		expect(localSettings.sidebarChatItemLayout).toBe('single-line');

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Chat display' });
		await fireEvent.click(screen.getByRole('radio', { name: /Medium/ }));
		expect(localSettings.chatMaxWidth).toBe('medium');

		const showThinking = localSettings.showThinking;
		const autoExpandTools = localSettings.autoExpandTools;
		const combineToolUseMessages = localSettings.combineToolUseMessages;
		expect(
			screen.getAllByRole('switch').map((element) => element.getAttribute('aria-label')),
		).toEqual(['Show thinking', 'Combine tool use messages', 'Always expand tool calls']);
		await fireEvent.click(screen.getByRole('switch', { name: 'Show thinking' }));
		expect(localSettings.showThinking).toBe(!showThinking);
		expect(localSettings.autoExpandTools).toBe(autoExpandTools);
		expect(localSettings.combineToolUseMessages).toBe(combineToolUseMessages);
		await fireEvent.click(screen.getByRole('switch', { name: 'Combine tool use messages' }));
		expect(localSettings.combineToolUseMessages).toBe(!combineToolUseMessages);
		expect(localSettings.autoExpandTools).toBe(autoExpandTools);
		await fireEvent.click(screen.getByRole('switch', { name: 'Always expand tool calls' }));
		expect(localSettings.showThinking).toBe(!showThinking);
		expect(localSettings.autoExpandTools).toBe(!autoExpandTools);
	});

	it('limits System slots to compatible concrete themes', async () => {
		const { localSettings } = renderWizard();
		await advanceToThemePage();

		const lightSelect = screen.getByRole('combobox', { name: 'Light theme' });
		const darkSelect = screen.getByRole('combobox', { name: 'Dark theme' });
		expect([...lightSelect.querySelectorAll('option')].map((option) => option.value)).toEqual(
			LIGHT_THEME_PROFILES.map((profile) => profile.id),
		);
		expect([...darkSelect.querySelectorAll('option')].map((option) => option.value)).toEqual(
			DARK_THEME_PROFILES.map((profile) => profile.id),
		);

		await fireEvent.change(lightSelect, { target: { value: 'classic-light' } });
		await fireEvent.change(darkSelect, { target: { value: 'colorblind-dark' } });

		expect(localSettings.themePreference).toEqual({
			mode: 'system',
			lightThemeId: 'classic-light',
			darkThemeId: 'colorblind-dark',
		});
	});

	it('persists sidebar organization and writing preferences without leaving setup', async () => {
		const { localSettings } = renderWizard();
		await advanceToThemePage();
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		const grouping = screen.getByRole('combobox', { name: 'Chat grouping' });
		const projectPath = screen.getByRole('checkbox', { name: 'Show project path' });
		const dockRight = screen.getByRole('checkbox', { name: 'Dock sidebar on the right' });
		await fireEvent.click(projectPath);
		await fireEvent.click(dockRight);
		expect(localSettings.sidebarShowProjectPath).toBe(true);
		expect(localSettings.chatListDock).toBe('right');
		await fireEvent.click(dockRight);
		expect(localSettings.chatListDock).toBe('left');
		await fireEvent.click(dockRight);
		expect((grouping as HTMLSelectElement).value).toBe('none');
		expect(
			(screen.getByRole('radio', { name: 'Recent activity' }) as HTMLInputElement).checked,
		).toBe(true);
		await fireEvent.change(grouping, { target: { value: 'project' } });
		await fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
		expect(localSettings.sidebarGrouping).toBe('project');
		expect(localSettings.sidebarSortMode).toBe('manual');
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Writing and behavior' });
		await fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Send by Shift+Enter' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Auto-scroll' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Reduce motion' }));
		expect(localSettings.snapshot()).toMatchObject({
			composerInputMode: 'source',
			sidebarShowProjectPath: true,
			chatListDock: 'right',
			sendByShiftEnter: true,
			autoScrollToBottom: false,
			reduceMotion: true,
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(
			(screen.getByRole('combobox', { name: 'Chat grouping' }) as HTMLSelectElement).value,
		).toBe('project');
	});

	it('dismisses automatic setup even when closing before making any selection', async () => {
		const { appShell, localSettings } = renderWizard();
		await screen.findByRole('heading', { name: 'Welcome to Garcon' });
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(appShell.showOnboardingWizard).toBe(false);
		expect(localSettings.hadSavedSettingsOnLoad).toBe(false);
		const restored = createLocalSettingsStore();
		expect(restored.hadSavedSettingsOnLoad).toBe(true);
		restored.destroy();
	});

	it('previews a fixed family and pairs it when following System', async () => {
		const { localSettings } = renderWizard();
		await advanceToThemePage();
		await fireEvent.click(screen.getByRole('radio', { name: /Use one theme/ }));
		await fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), {
			target: { value: 'rose-dark' },
		});
		expect(
			document.querySelector('[data-theme-preview="rose-dark"][aria-hidden="true"]'),
		).toBeTruthy();
		await fireEvent.click(screen.getByRole('radio', { name: /Follow system/ }));
		expect(localSettings.themePreference).toEqual({
			mode: 'system',
			lightThemeId: 'rose-light',
			darkThemeId: 'rose-dark',
		});
		expect(
			[...document.querySelectorAll('[data-theme-preview]')].map((element) =>
				element.getAttribute('data-theme-preview'),
			),
		).toEqual(['rose-light', 'rose-dark']);
	});

	it('renders real sidebar previews for each layout option and tracks the selection', async () => {
		const { localSettings } = renderWizard();
		await advanceToThemePage();
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Arrange your sidebar' });

		const previews = document.querySelectorAll('[data-onboarding-layout-preview]');
		expect(previews).toHaveLength(3);

		const previewFor = (layout: string) => {
			const preview = document.querySelector(`[data-onboarding-layout-preview="${layout}"]`);
			if (!preview) throw new Error(`Missing layout preview for ${layout}`);
			return preview;
		};

		// Only the detailed layout renders the sample last-message line.
		const sampleMessage = 'Draft the release notes and verify the upgrade path.';
		expect(previewFor('detailed').textContent).toContain(sampleMessage);
		expect(previewFor('compact').textContent).not.toContain(sampleMessage);
		expect(previewFor('single-line').textContent).not.toContain(sampleMessage);
		expect(document.body.textContent).not.toContain('/workspace/aurora');

		expect(previewFor(localSettings.sidebarChatItemLayout).getAttribute('data-selected')).toBe(
			'true',
		);

		await fireEvent.click(screen.getByRole('radio', { name: /Single line/ }));
		expect(previewFor('single-line').getAttribute('data-selected')).toBe('true');
		expect(previewFor('compact').getAttribute('data-selected')).toBe('false');
	});

	it('enables workspace transcript search and retains an explicit opt-out across pages', async () => {
		const { remoteSettings } = renderWizard();
		await advanceToSearchPage();
		const toggle = screen.getByRole('switch', { name: 'Transcript search' });
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		expect(updateRemoteSettings).toHaveBeenCalledExactlyOnceWith({
			features: { transcriptSearch: { enabled: true } },
		});
		expect(screen.getByRole('link', { name: /garcon-captain/ }).getAttribute('href')).toBe(
			'https://github.com/cfal/garcon-skills',
		);
		expect(screen.getByText('"Find the chat where I discussed topic A"')).toBeTruthy();
		await fireEvent.click(toggle);
		await waitFor(() =>
			expect(remoteSettings.snapshot?.features.transcriptSearch.enabled).toBe(false),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(
			screen.getByRole('switch', { name: 'Transcript search' }).getAttribute('aria-checked'),
		).toBe('false');
		expect(updateRemoteSettings).toHaveBeenCalledTimes(2);
	});

	it('blocks Continue but keeps Back and Close available while search is saving', async () => {
		renderWizard();
		const saved = Promise.withResolvers<Awaited<ReturnType<typeof updateRemoteSettings>>>();
		vi.mocked(updateRemoteSettings).mockReturnValueOnce(saved.promise);
		await visitSearchPage();
		expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
		expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(false);
		expect(screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(false);
		const snapshot = makeRemoteSettingsSnapshot();
		snapshot.features.transcriptSearch.enabled = true;
		saved.resolve({ success: true, settings: snapshot });
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false),
		);
	});

	it('keeps the switch on after a failed opt-out and returns Retry focus to it', async () => {
		const { remoteSettings } = renderWizard();
		await advanceToSearchPage();
		const toggle = screen.getByRole('switch', { name: 'Transcript search' });
		toggle.focus();
		vi.mocked(updateRemoteSettings).mockRejectedValueOnce(new Error('Save failed'));
		await fireEvent.click(toggle);
		await screen.findByRole('alert');
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		expect(remoteSettings.snapshot?.features.transcriptSearch.enabled).toBe(true);
		expect(document.activeElement).toBe(toggle);
		const retry = screen.getByRole('button', { name: 'Retry' });
		retry.focus();
		await fireEvent.click(retry);
		await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
		expect(document.activeElement).toBe(toggle);
		expect(remoteSettings.snapshot?.features.transcriptSearch.enabled).toBe(false);
	});

	it('shows a search save failure and retries without pretending it succeeded', async () => {
		renderWizard();
		vi.mocked(updateRemoteSettings).mockRejectedValueOnce(new Error('Settings are unavailable.'));
		await advanceToSearchPage();
		expect((await screen.findByRole('alert')).textContent).toBe(
			"Couldn't update transcript search. Please try again.",
		);
		const toggle = screen.getByRole('switch', { name: 'Transcript search' });
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('makes provider setup the only final primary action', async () => {
		const { appShell } = renderWizard();
		await advanceToDonePage();
		expect(screen.queryByRole('button', { name: 'Start using Garcon' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Set up API providers' }));
		expect(appShell.showOnboardingWizard).toBe(false);
		expect(appShell.showSettings).toBe(true);
		expect(appShell.settingsTab).toBe('providers');
	});

	it('can still close from the done page without opening settings', async () => {
		const { appShell } = renderWizard();
		await advanceToDonePage();

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(appShell.showOnboardingWizard).toBe(false);
		expect(appShell.showSettings).toBe(false);
	});

	it.each([
		['Scheduled Tasks', 'showScheduledPrompts', 'Send prompts later or on a recurring schedule.'],
		['Preambles', 'showPreambles', 'Reuse instructions across chats.'],
	] as const)(
		'opens %s from the final page and persists preferences',
		async (name, property, description) => {
			const { appShell } = renderWizard();
			await advanceToDonePage();
			expect(screen.getByText(description)).toBeTruthy();
			await fireEvent.click(screen.getByRole('button', { name }));
			expect(appShell.showOnboardingWizard).toBe(false);
			expect(appShell[property]).toBe(true);
			expect(appShell.showSettings).toBe(false);
			const restored = createLocalSettingsStore();
			expect(restored.hadSavedSettingsOnLoad).toBe(true);
			restored.destroy();
		},
	);

	it('returns from the done page to revise transcript search', async () => {
		renderWizard();
		await advanceToDonePage();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		await screen.findByRole('heading', { name: 'Search your conversations' });
	});

	it('announces the current step position', async () => {
		renderWizard();
		await screen.findByRole('heading', { name: 'Welcome to Garcon' });
		const stepStatus = screen.getByText('Step 1 of 7');
		expect(stepStatus.getAttribute('aria-live')).toBe('polite');

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

		await waitFor(() => expect(stepStatus.textContent).toBe('Step 2 of 7'));
	});

	it('restarts on the welcome page after closing', async () => {
		const { appShell } = renderWizard();
		await advanceToDonePage();
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		appShell.openOnboardingWizard();

		await screen.findByRole('heading', { name: 'Welcome to Garcon' });
		expect(screen.queryByRole('heading', { name: "What's next" })).toBeNull();
	});
});
