import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';

const OnboardingWizardTestHost = (await import('./OnboardingWizardTestHost.svelte')).default;

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
		await screen.findByRole('heading', { name: "You're all set" });
	}

	it('advances through the pages and moves focus to each page heading', async () => {
		renderWizard();

		const themeHeading = await screen.findByRole('heading', { name: 'Choose your theme' });
		await waitFor(() => expect(document.activeElement).toBe(themeHeading));

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		const layoutHeading = await screen.findByRole('heading', { name: 'Chat list layout' });
		await waitFor(() => expect(document.activeElement).toBe(layoutHeading));

		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await screen.findByRole('heading', { name: 'Choose your theme' });
	});

	it('writes radio selections to local settings', async () => {
		const { localSettings } = renderWizard();
		await screen.findByRole('heading', { name: 'Choose your theme' });

		await fireEvent.click(screen.getByRole('radio', { name: /Dark/ }));
		expect(localSettings.theme).toBe('dark');

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Chat list layout' });
		await fireEvent.click(screen.getByRole('radio', { name: /Single line/ }));
		expect(localSettings.sidebarChatItemLayout).toBe('single-line');

		await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('heading', { name: 'Chat display' });
		await fireEvent.click(screen.getByRole('radio', { name: /Medium/ }));
		expect(localSettings.chatMaxWidth).toBe('medium');
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
});
