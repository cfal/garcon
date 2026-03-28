<script lang="ts">
	// Cycles the compact theme toggle through the supported display modes.

	import Sun from '@lucide/svelte/icons/sun';
	import Moon from '@lucide/svelte/icons/moon';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Circle from '@lucide/svelte/icons/circle';
	import type { ThemeMode } from '$lib/stores/preferences.svelte.js';
	import { getPreferences } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	const preferences = getPreferences();

	const cycle: ThemeMode[] = ['dark', 'light', 'system', 'oled'];

	function themeLabel(mode: ThemeMode): string {
		if (mode === 'dark') return m.settings_theme_dark();
		if (mode === 'light') return m.settings_theme_light();
		if (mode === 'oled') return m.settings_theme_oled();
		return m.settings_theme_system();
	}

	function toggle() {
		const idx = cycle.indexOf(preferences.theme);
		const next = cycle[(idx + 1) % cycle.length];
		preferences.setPreference('theme', next);
	}
</script>

<button
	onclick={toggle}
	class="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	aria-label={`${m.settings_appearance_settings_dark_mode_label()}: ${themeLabel(preferences.theme)}`}
	title={`${m.settings_appearance_settings_dark_mode_label()}: ${themeLabel(preferences.theme)}`}
>
	{#if preferences.theme === 'dark'}
		<Moon class="h-4 w-4" />
	{:else if preferences.theme === 'light'}
		<Sun class="h-4 w-4" />
	{:else if preferences.theme === 'oled'}
		<Circle class="h-4 w-4 fill-current" />
	{:else}
		<Monitor class="h-4 w-4" />
	{/if}
</button>
