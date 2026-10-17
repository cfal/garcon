<script lang="ts">
	import type { ThemeId } from '$lib/theme/themes.js';

	let { themeId }: { themeId: ThemeId } = $props();
</script>

<span
	data-theme-preview={themeId}
	aria-hidden="true"
	class="inline-grid h-4 w-16 shrink-0 grid-cols-4 overflow-hidden rounded-sm border border-border"
>
	<span class="bg-background"></span>
	<span class="bg-card"></span>
	<span class="bg-primary"></span>
	<span class="bg-interactive-accent"></span>
</span>
