<script lang="ts">
	import TypeIcon from '@lucide/svelte/icons/type';
	import { Button } from '$lib/components/ui/button';
	import {
		TYPOGRAPHY_SURFACE_LABELS,
		fontControlLabel,
		fontLabel,
		typographySizeLabel,
	} from '$lib/components/shared/typography-labels.js';
	import { getLocalSettings } from '$lib/context';
	import { TYPOGRAPHY_SURFACES, type TypographySurface } from '$lib/theme/typography.js';
	import * as m from '$lib/paraglide/messages.js';
	import TypographyDialog from './TypographyDialog.svelte';

	const settings = getLocalSettings();
	let activeSurface = $state<TypographySurface | null>(null);
</script>

<section class="@container border-y border-border py-3" aria-labelledby="typography-heading">
	<h3 id="typography-heading" class="mb-2 text-sm font-semibold">{m.settings_typography()}</h3>
	{#each TYPOGRAPHY_SURFACES as { id, fontKey, sizeKey } (id)}
		{@const summary = `${fontLabel(id, settings[fontKey])} \u00b7 ${typographySizeLabel(id, settings[sizeKey])}`}
		<div
			class="grid min-w-0 gap-2 py-2 @lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)] @lg:items-center @lg:gap-3"
		>
			<span class="text-sm font-medium">{TYPOGRAPHY_SURFACE_LABELS[id]()}</span>
			<Button
				variant="outline"
				class="h-auto min-h-11 w-full min-w-0 justify-start whitespace-normal text-left"
				aria-label={`${fontControlLabel(id)}: ${summary}`}
				aria-haspopup="dialog"
				onclick={() => {
					activeSurface = id;
				}}
			>
				<TypeIcon class="size-4 shrink-0" />
				<span class="min-w-0 break-words">{summary}</span>
			</Button>
		</div>
	{/each}
</section>

{#if activeSurface}
	<TypographyDialog
		surface={activeSurface}
		onClose={() => {
			activeSurface = null;
		}}
	/>
{/if}
