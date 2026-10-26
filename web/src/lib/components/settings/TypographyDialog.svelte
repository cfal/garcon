<script lang="ts">
	import { untrack } from 'svelte';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getLocalSettings } from '$lib/context';
	import { fontControlLabel, fontLabel } from '$lib/components/shared/typography-labels.js';
	import { FONT_OPTIONS, type FontPreference } from '$lib/theme/fonts.js';
	import {
		TYPOGRAPHY_SURFACES,
		TYPOGRAPHY_SIZE_OPTIONS,
		parseSurfaceFont,
		parseFontSizePreference,
		type FontSizePreference,
		type TypographySurface,
	} from '$lib/theme/typography.js';
	import * as m from '$lib/paraglide/messages.js';
	import TypographyPreview from './TypographyPreview.svelte';

	let { surface, onClose }: { surface: TypographySurface; onClose: () => void } = $props();
	const settings = getLocalSettings();
	const definition = untrack(() => TYPOGRAPHY_SURFACES.find(({ id }) => id === surface)!);
	let font = $state<FontPreference>(untrack(() => settings[definition.fontKey]));
	let size = $state<FontSizePreference>(untrack(() => settings[definition.sizeKey]));
	const fonts = $derived(
		FONT_OPTIONS.filter((choice) => parseSurfaceFont(surface, choice) === choice),
	);
	const scaled = $derived(surface === 'interface' || surface === 'chat-list');
	const editing = $derived(['code-editor', 'expanded-editor', 'code-diff'].includes(surface));
	const defaultSizeLabel = $derived.by(() => {
		if (surface === 'code-diff') return '11-13';
		if (surface === 'chat-code') return '11/12';
		return String(definition.defaultSize);
	});

	function apply(event: SubmitEvent): void {
		event.preventDefault();
		settings.setTypography(surface, font, size);
		onClose();
	}
</script>

<Dialog.Root open requestClose={onClose}>
	<Dialog.Content class="max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
		<Dialog.Header class="pe-8">
			<Dialog.Title>{fontControlLabel(surface)}</Dialog.Title>
		</Dialog.Header>
		<form class="grid min-w-0 gap-4" onsubmit={apply}>
			<div class="grid min-w-0 gap-3">
				<fieldset class="min-w-0">
					<legend class="text-sm font-medium">{m.settings_font()}</legend>
					<div class="grid min-w-0 sm:grid-cols-2 sm:gap-x-3">
						{#each fonts as choice (choice)}
							<label
								class={[
									'flex min-h-11 min-w-0 cursor-pointer items-center gap-2 py-1 text-sm',
									choice === 'default' && 'sm:col-span-2',
								]}
							>
								<input
									type="radio"
									name="typography-font"
									value={choice}
									checked={font === choice}
									onchange={() => {
										font = choice;
									}}
								/>
								<span class="min-w-0 break-words"
									>{fontLabel(surface, choice)}{choice === 'default'
										? ` (${m.settings_appearance_default()})`
										: ''}</span
								>
							</label>
						{/each}
					</div>
				</fieldset>
				<label class="grid min-w-0 gap-1 text-sm font-medium">
					{scaled ? m.settings_font_base_size() : m.settings_font_size_px()}
					<select
						class="select-native min-h-11 w-full min-w-0 text-base"
						style:font-size="max(16px, calc(14px * var(--interface-font-scale, 1)))"
						value={size}
						onchange={(event) => {
							size = parseFontSizePreference(event.currentTarget.value);
						}}
					>
						{#each TYPOGRAPHY_SIZE_OPTIONS as choice (choice)}
							<option value={choice}
								>{choice === 'default'
									? `${defaultSizeLabel} (${m.settings_appearance_default()})`
									: choice}</option
							>
						{/each}
					</select>
				</label>
			</div>
			<div class="min-w-0">
				<h3 class="mb-2 text-sm font-medium">{m.settings_font_preview()}</h3>
				<TypographyPreview {surface} {font} {size} />
			</div>
			{#if editing}<p class="text-xs text-muted-foreground">
					{m.settings_font_touch_minimum()}
				</p>{/if}
			{#if surface === 'terminal'}<p class="text-xs text-muted-foreground">
					{m.settings_font_terminal_fallback()}
				</p>{/if}
			<div class="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					class="min-h-11"
					onclick={() => {
						font = 'default';
						size = 'default';
					}}><RotateCcwIcon class="size-4" />{m.settings_font_reset()}</Button
				>
				<div class="ml-auto flex gap-2">
					<Button type="button" variant="outline" class="min-h-11" onclick={onClose}
						>{m.common_cancel()}</Button
					>
					<Button type="submit" class="min-h-11">{m.settings_font_apply()}</Button>
				</div>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
