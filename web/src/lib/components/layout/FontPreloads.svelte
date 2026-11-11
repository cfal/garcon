<script lang="ts">
	import departure from '$lib/theme/assets/DepartureMono-1.500-core.woff2?url&no-inline';
	import jetbrains from '$lib/theme/assets/JetBrainsMono-core.woff2?url&no-inline';
	import inter from '$lib/theme/assets/InterVariable.woff2?url&no-inline';
	import sourceSans from '$lib/theme/assets/SourceSans3.woff2?url&no-inline';
	import atkinson from '$lib/theme/assets/AtkinsonHyperlegible-Regular.woff2?url&no-inline';
	import sourceSerif from '$lib/theme/assets/SourceSerif4.woff2?url&no-inline';
	import plexMono from '$lib/theme/assets/IBMPlexMono-Regular.woff2?url&no-inline';
	import sourceCode from '$lib/theme/assets/SourceCodePro.woff2?url&no-inline';
	import arimo from '$lib/theme/assets/Arimo.woff2?url&no-inline';
	import roboto from '$lib/theme/assets/Roboto.woff2?url&no-inline';
	import { isBundledFont, type BundledFont } from '$lib/theme/fonts.js';
	import { TYPOGRAPHY_SURFACES, type TypographyPreferences } from '$lib/theme/typography.js';

	let { typography }: { typography: TypographyPreferences } = $props();
	const sources: Record<BundledFont, string> = {
		'departure-mono': departure,
		'jetbrains-mono': jetbrains,
		inter,
		'source-sans-3': sourceSans,
		'atkinson-hyperlegible': atkinson,
		'source-serif-4': sourceSerif,
		'ibm-plex-mono': plexMono,
		'source-code-pro': sourceCode,
		arimo,
		roboto,
	};
	const selected = $derived.by(() => {
		const urls = new Set<string>();
		for (const { fontKey } of TYPOGRAPHY_SURFACES) {
			const font = typography[fontKey];
			if (isBundledFont(font)) urls.add(sources[font]);
		}
		return [...urls];
	});
</script>

<svelte:head>
	{#each selected as href (href)}
		<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" {href} />
	{/each}
</svelte:head>
