<script lang="ts">
	import { getLocalSettings } from '$lib/context';
	import { FONT_OPTIONS, parseFontPreference, type FontPreference } from '$lib/theme/fonts.js';
	import * as m from '$lib/paraglide/messages.js';

	const settings = getLocalSettings();
	const fontSettings = ['interfaceFont', 'monospaceFont'] as const;
	const fontLabels: Record<FontPreference, () => string> = {
		default: m.settings_appearance_default,
		'departure-mono': m.settings_font_departure_mono,
	};
</script>

<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
	<label class="min-w-0 text-sm font-medium text-foreground" for="local-appearance">
		{m.settings_appearance()}
	</label>
	<select
		id="local-appearance"
		class="select-native w-52 max-w-full shrink-0 bg-position-[right_0.25rem_center] pl-1 pr-5"
		value={settings.terminalAppearance ? 'terminal' : 'default'}
		onchange={(event) =>
			settings.set('terminalAppearance', event.currentTarget.value === 'terminal')}
	>
		<option value="default">{m.settings_appearance_default()}</option>
		<option value="terminal">{m.settings_appearance_terminal()}</option>
	</select>
</div>

{#each fontSettings as key (key)}
	<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
		<label class="min-w-0 text-sm font-medium text-foreground" for={`local-${key}`}>
			{key === 'interfaceFont' ? m.settings_font() : m.settings_monospace_font()}
		</label>
		<select
			id={`local-${key}`}
			class="select-native w-52 max-w-full shrink-0 bg-position-[right_0.25rem_center] pl-1 pr-5"
			value={settings[key]}
			onchange={(event) => settings.set(key, parseFontPreference(event.currentTarget.value))}
		>
			{#each FONT_OPTIONS as font (font)}
				<option value={font}>{fontLabels[font]()}</option>
			{/each}
		</select>
	</div>
{/each}
