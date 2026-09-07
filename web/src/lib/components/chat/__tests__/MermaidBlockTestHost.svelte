<script lang="ts">
	import { setThemeRuntime } from '$lib/context';
	import { getThemeProfile, type ThemeId } from '$lib/theme/themes.js';
	import MermaidBlock from '../MermaidBlock.svelte';
	import { untrack } from 'svelte';

	interface MermaidBlockTestHostProps {
		text?: string;
		themeId?: ThemeId;
		acquireTransientActivity?: (close: () => void) => () => void;
	}

	let {
		text = '',
		themeId = 'classic-light',
		acquireTransientActivity,
	}: MermaidBlockTestHostProps = $props();
	let activeThemeId = $state(untrack(() => themeId));

	setThemeRuntime({
		get profile() {
			return getThemeProfile(activeThemeId);
		},
	});

	export function setThemeId(next: ThemeId): void {
		activeThemeId = next;
	}
</script>

<MermaidBlock {text} {acquireTransientActivity} />
