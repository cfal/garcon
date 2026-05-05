<script lang="ts">
	import type { HarnessReadiness } from '$lib/api/providers';
	import * as m from '$lib/paraglide/messages.js';
	import { harnessLabelFor } from '$lib/i18n/harness-labels';
	import HarnessCard from './HarnessCard.svelte';

	interface AuthStatus {
		authenticated: boolean;
		canReauth: boolean;
		label: string;
		loading: boolean;
		error: string | null;
	}

	type HarnessConfig = {
		id: 'opencode' | 'amp' | 'factory';
		loginCommand: string;
	};

	const harnesses: HarnessConfig[] = [
		{ id: 'opencode', loginCommand: 'opencode auth login' },
		{ id: 'amp', loginCommand: 'amp login' },
		{ id: 'factory', loginCommand: 'droid' }
	];

	let {
		authByHarness,
		readinessByHarness
	}: {
		authByHarness: Record<string, AuthStatus>;
		readinessByHarness: Record<string, HarnessReadiness>;
	} = $props();

	const fallbackAuth: AuthStatus = {
		authenticated: false,
		canReauth: false,
		label: '',
		loading: false,
		error: null
	};

	let openByHarness = $state<Record<string, boolean>>({});

	function isOpen(harnessId: string): boolean {
		return openByHarness[harnessId] ?? false;
	}

	function setOpen(harnessId: string, open: boolean): void {
		openByHarness = { ...openByHarness, [harnessId]: open };
	}
</script>

<section class="space-y-3">
	<div class="space-y-1">
		<h2 class="text-base font-semibold text-foreground">{m.settings_other_harnesses_title()}</h2>
		<p class="text-sm text-muted-foreground">
			{m.settings_other_harnesses_description()}
		</p>
	</div>

	<div class="space-y-3">
		{#each harnesses as harness (harness.id)}
			<HarnessCard
				harnessId={harness.id}
				harnessName={harnessLabelFor(harness.id)}
				auth={authByHarness[harness.id] ?? fallbackAuth}
				open={isOpen(harness.id)}
				onOpenChange={(open) => setOpen(harness.id, open)}
				cliOnly={true}
				loginCommand={harness.loginCommand}
				readiness={readinessByHarness[harness.id]}
			/>
		{/each}
	</div>
</section>
