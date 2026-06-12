<script lang="ts">
	// Three-state theme toggle (dark / light / system). Reads and writes
	// the local settings store, cycling through states on each click.

	import Sun from '@lucide/svelte/icons/sun';
	import Moon from '@lucide/svelte/icons/moon';
	import Monitor from '@lucide/svelte/icons/monitor';
	import type { ThemeMode } from '$lib/stores/local-settings.svelte.js';
	import { getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	const localSettings = getLocalSettings();

	const cycle: ThemeMode[] = ['dark', 'light', 'system'];

	function toggle() {
		const idx = cycle.indexOf(localSettings.theme);
		const next = cycle[(idx + 1) % cycle.length];
		localSettings.set('theme', next);
	}
</script>

<button
	onclick={toggle}
	class="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	aria-label={m.settings_theme_toggle_aria({ theme: localSettings.theme })}
	title={m.settings_theme_toggle_title({ theme: localSettings.theme })}
>
	{#if localSettings.theme === 'dark'}
		<Moon class="h-4 w-4" />
	{:else if localSettings.theme === 'light'}
		<Sun class="h-4 w-4" />
	{:else}
		<Monitor class="h-4 w-4" />
	{/if}
</button>
