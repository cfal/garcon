<script lang="ts">
	// Three-state theme toggle (dark / light / system). Reads and writes
	// the preferences store, cycling through states on each click.

	import Sun from '@lucide/svelte/icons/sun';
	import Moon from '@lucide/svelte/icons/moon';
	import Monitor from '@lucide/svelte/icons/monitor';
	import type { ThemeMode } from '$lib/stores/preferences.svelte.js';
	import { getPreferences } from '$lib/context';

	const preferences = getPreferences();

	const cycle: ThemeMode[] = ['dark', 'light', 'system'];

	function toggle() {
		const idx = cycle.indexOf(preferences.theme);
		const next = cycle[(idx + 1) % cycle.length];
		preferences.setPreference('theme', next);
	}
</script>

<button
	onclick={toggle}
	class="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	aria-label="Toggle theme: {preferences.theme}"
	title="Theme: {preferences.theme}"
>
	{#if preferences.theme === 'dark'}
		<Moon class="h-4 w-4" />
	{:else if preferences.theme === 'light'}
		<Sun class="h-4 w-4" />
	{:else}
		<Monitor class="h-4 w-4" />
	{/if}
</button>
