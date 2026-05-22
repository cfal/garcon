<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { harnessLabelFor } from '$lib/i18n/harness-labels';
	import HarnessCard from './HarnessCard.svelte';
	import type { SettingsAuthState } from './settings-auth-state.svelte.js';

	type HarnessConfig = {
		id: 'opencode' | 'amp' | 'cursor' | 'factory' | 'pi';
		loginCommand: string;
	};

	const harnesses: HarnessConfig[] = [
		{ id: 'amp', loginCommand: 'amp login' },
		{ id: 'cursor', loginCommand: 'cursor-agent login' },
		{ id: 'factory', loginCommand: 'droid' },
		{ id: 'opencode', loginCommand: 'opencode auth login' },
		{ id: 'pi', loginCommand: 'pi' }
	];

	let { settingsAuth }: { settingsAuth: SettingsAuthState } = $props();

	let openByHarness = $state<Record<string, boolean>>({});

	function isOpen(harnessId: string): boolean {
		return openByHarness[harnessId] ?? false;
	}

	function setOpen(harnessId: string, open: boolean): void {
		openByHarness = { ...openByHarness, [harnessId]: open };
	}
</script>

<section class="space-y-4">
	<p class="text-sm text-muted-foreground">
		{m.settings_other_harnesses_description()}
	</p>

	<div class="space-y-3">
		{#each harnesses as harness (harness.id)}
			<HarnessCard
				harnessId={harness.id}
				harnessName={harnessLabelFor(harness.id)}
				auth={settingsAuth.authFor(harness.id)}
				open={isOpen(harness.id)}
				onOpenChange={(open) => setOpen(harness.id, open)}
				cliOnly={true}
				loginCommand={harness.loginCommand}
				readiness={settingsAuth.readinessFor(harness.id)}
			/>
		{/each}
	</div>
</section>
