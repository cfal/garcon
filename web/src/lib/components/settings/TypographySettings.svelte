<script lang="ts">
	import {
		TYPOGRAPHY_SURFACE_LABELS,
		fontControlLabel,
		fontSizeControlLabel,
		fontSizeLabel,
	} from '$lib/components/shared/typography-labels.js';
	import { getLocalSettings } from '$lib/context';
	import { FONT_OPTIONS, parseFontPreference, type FontPreference } from '$lib/theme/fonts.js';
	import {
		TYPOGRAPHY_SURFACES,
		TYPOGRAPHY_SIZE_OPTIONS,
		parseFontSizePreference,
	} from '$lib/theme/typography.js';
	import * as m from '$lib/paraglide/messages.js';

	const settings = getLocalSettings();
	const fontLabels: Record<FontPreference, () => string> = {
		default: m.settings_appearance_default,
		'departure-mono': m.settings_font_departure_mono,
	};
</script>

<div class="flex flex-wrap items-center justify-between gap-2 py-3">
	<label class="text-sm font-medium" for="local-appearance">{m.settings_ui_style()}</label>
	<select
		id="local-appearance"
		class="select-native w-full sm:w-52"
		value={settings.terminalAppearance ? 'terminal' : 'default'}
		onchange={(event) =>
			settings.set('terminalAppearance', event.currentTarget.value === 'terminal')}
	>
		<option value="default">{m.settings_appearance_default()}</option>
		<option value="terminal">{m.settings_appearance_terminal()}</option>
	</select>
</div>

<section class="@container border-y border-border py-3" aria-labelledby="typography-heading">
	<h3 id="typography-heading" class="mb-2 text-sm font-semibold">{m.settings_typography()}</h3>
	{#each TYPOGRAPHY_SURFACES as { id, fontKey, sizeKey } (id)}
		<fieldset
			class="min-w-0 border-0 py-2 @xl:grid @xl:grid-cols-[minmax(0,1fr)_17rem_8rem] @xl:items-center @xl:gap-3"
		>
			<legend class="float-left mb-1 w-full text-sm font-medium @xl:mb-0"
				>{TYPOGRAPHY_SURFACE_LABELS[id]()}</legend
			>
			<select
				id={`local-${fontKey}`}
				class="typography-font-select select-native mb-2 w-full min-w-0 pr-7 @xl:mb-0"
				aria-label={fontControlLabel(id)}
				value={settings[fontKey]}
				onchange={(event) => settings.set(fontKey, parseFontPreference(event.currentTarget.value))}
			>
				{#each FONT_OPTIONS as font (font)}
					<option value={font}>{fontLabels[font]()}</option>
				{/each}
			</select>
			<select
				id={`local-${sizeKey}`}
				class="select-native w-full min-w-0"
				aria-label={fontSizeControlLabel(id)}
				value={settings[sizeKey]}
				onchange={(event) =>
					settings.set(sizeKey, parseFontSizePreference(event.currentTarget.value))}
			>
				{#each TYPOGRAPHY_SIZE_OPTIONS as size (size)}
					<option value={size}>{fontSizeLabel(size)}</option>
				{/each}
			</select>
		</fieldset>
	{/each}
</section>

<style>
	@container (max-width: 16rem) {
		.typography-font-select {
			font-size: min(18px, max(16px, calc(14px * var(--interface-font-scale, 1))));
		}
	}
</style>
