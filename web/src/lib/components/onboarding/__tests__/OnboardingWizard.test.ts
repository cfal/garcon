import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
import { DARK_THEME_PROFILES, LIGHT_THEME_PROFILES } from '$lib/theme/themes.js';

const OnboardingWizardTestHost = (await import('./OnboardingWizardTestHost.svelte')).default;

async function waitForAnimationFrames(count: number): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	}
}

describe('OnboardingWizard', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	function renderWizard() {
		const appShell = createAppShellStore();
		const localSettings = createLocalSettingsStore();
		appShell.openOnboardingWizard();
		render(OnboardingWizardTestHost, { appShell, localSettings });
		return { appShell, localSettings };
	}

	async function advanceToDonePage() {
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Chat list layout' });
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Chat display' });
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Writing preferences' });
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: "You're all set" });
		expect(
			screen.getByText(
				'Your preferences are saved. Adjust them anytime in Settings > Appearance or Behavior.',
			),
		).toBeTruthy();
	}

	it('advances through the pages and moves focus to each page heading', async () => {
		renderWizard();

		const themeHeading = await screen.findByRole('heading', { name: 'Choose your theme' });
		await waitForAnimationFrames(2);
		await waitFor(() => expect(document.activeElement).toBe(themeHeading));

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		const layoutHeading = await screen.findByRole('heading', { name: 'Chat list layout' });
		await waitFor(() => expect(document.activeElement).toBe(layoutHeading));

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await screen.findByRole('heading', { name: 'Choose your theme' });
	});

	it('writes theme and display selections to local settings', async () => {
		const { localSettings } = renderWizard();
		await screen.findByRole('heading', { name: 'Choose your theme' });

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
		await screen.findByRole('heading', { name: 'Chat list layout' });
		await fireEvent.click(screen.getByRole('radio', { name: /Single line/ }));
		expect(localSettings.sidebarChatItemLayout).toBe('single-line');

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Chat display' });
		await fireEvent.click(screen.getByRole('radio', { name: /Medium/ }));
		expect(localSettings.chatMaxWidth).toBe('medium');
	});

	it('limits System slots to compatible concrete themes', async () => {
		const { localSettings } = renderWizard();
		await screen.findByRole('heading', { name: 'Choose your theme' });

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
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		const grouping = screen.getByRole('combobox', { name: 'Chat grouping' });
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
		await screen.findByRole('heading', { name: 'Writing preferences' });
		await fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Send by Shift+Enter' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Auto-scroll' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Reduce motion' }));
		expect(localSettings.snapshot()).toMatchObject({
			composerInputMode: 'source',
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
		await screen.findByRole('heading', { name: 'Choose your theme' });
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(appShell.showOnboardingWizard).toBe(false);
		expect(localSettings.hadSavedSettingsOnLoad).toBe(false);
		const restored = createLocalSettingsStore();
		expect(restored.hadSavedSettingsOnLoad).toBe(true);
		restored.destroy();
	});

	it('previews a fixed family and pairs it when following System', async () => {
		const { localSettings } = renderWizard();
		await screen.findByRole('heading', { name: 'Choose your theme' });
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
		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Chat list layout' });

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

	it('finishes by closing the wizard, or closes into provider settings', async () => {
		const { appShell } = renderWizard();
		await advanceToDonePage();

		await fireEvent.click(screen.getByRole('button', { name: 'Set up API providers' }));
		expect(appShell.showOnboardingWizard).toBe(false);
		expect(appShell.showSettings).toBe(true);
		expect(appShell.settingsTab).toBe('providers');
	});

	it('closes on the done page primary action', async () => {
		const { appShell } = renderWizard();
		await advanceToDonePage();

		await fireEvent.click(screen.getByRole('button', { name: 'Start using Garcon' }));
		expect(appShell.showOnboardingWizard).toBe(false);
		expect(appShell.showSettings).toBe(false);
	});

	it('returns from the done page to revise writing preferences', async () => {
		renderWizard();
		await advanceToDonePage();

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

		await screen.findByRole('heading', { name: 'Writing preferences' });
	});

	it('announces the current step position', async () => {
		renderWizard();
		await screen.findByRole('heading', { name: 'Choose your theme' });
		const stepStatus = screen.getByText('Step 1 of 5');
		expect(stepStatus.getAttribute('aria-live')).toBe('polite');

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

		await waitFor(() => expect(stepStatus.textContent).toBe('Step 2 of 5'));
	});

	it('restarts on the theme page after closing', async () => {
		const { appShell } = renderWizard();
		await advanceToDonePage();
		await fireEvent.click(screen.getByRole('button', { name: 'Start using Garcon' }));

		appShell.openOnboardingWizard();

		await screen.findByRole('heading', { name: 'Choose your theme' });
		expect(screen.queryByRole('heading', { name: "You're all set" })).toBeNull();
	});
});
