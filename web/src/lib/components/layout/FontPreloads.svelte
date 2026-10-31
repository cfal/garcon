<script lang="ts">
	import departure from '$lib/theme/assets/DepartureMono-1.500-core.woff2?url&no-inline';
	import jetbrains from '$lib/theme/assets/JetBrainsMono-core.woff2?url&no-inline';
	import inter from '$lib/theme/assets/InterVariable.woff2?url&no-inline';
	import { TYPOGRAPHY_SURFACES, type TypographyPreferences } from '$lib/theme/typography.js';

	let { typography }: { typography: TypographyPreferences } = $props();
	const sources: Record<string, string> = {
		'departure-mono': departure,
		'jetbrains-mono': jetbrains,
		inter,
	};
	const selected = $derived([
		...new Set(TYPOGRAPHY_SURFACES.flatMap(({ fontKey }) => sources[typography[fontKey]] ?? [])),
	]);
</script>

<svelte:head>
	{#each selected as href (href)}
		<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" {href} />
	{/each}
</svelte:head>
