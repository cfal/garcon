<script lang="ts">
	import type { ThemeId } from '$lib/theme/themes.js';
	import Plus from '@lucide/svelte/icons/plus';
	import Minus from '@lucide/svelte/icons/minus';

	let { themeId }: { themeId: ThemeId } = $props();
</script>

<span
	data-theme-preview={themeId}
	aria-hidden="true"
	class="inline-grid h-4 w-24 shrink-0 grid-cols-6 overflow-hidden rounded-sm border border-border"
>
	<span class="bg-background"></span>
	<span class="bg-card"></span>
	<span class="bg-primary"></span>
	<span class="bg-interactive-accent"></span>
	<span class="flex items-center justify-center bg-diff-add text-diff-add-fg"
		><Plus class="size-3" /></span
	>
	<span class="flex items-center justify-center bg-diff-del text-diff-del-fg"
		><Minus class="size-3" /></span
	>
</span>
