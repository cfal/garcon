<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { getLocalSettings } from '$lib/context';
	import {
		COMPLETION_SOUND_MODE_VALUES,
		COMPLETION_SOUND_VISIBILITY_VALUES,
		type CompletionSoundMode,
		type CompletionSoundVisibility,
	} from '$lib/stores/local-settings.svelte.js';
	import {
		CUSTOM_COMPLETION_SOUND_ACCEPT,
		playCompletionSound,
		removeCustomCompletionSound,
		storeCustomCompletionSound,
		validateCustomCompletionSound,
	} from '$lib/notifications/completion-sound.js';
	import * as m from '$lib/paraglide/messages.js';

	const ls = getLocalSettings();
	let fileInput: HTMLInputElement | null = $state(null);
	let uploadError = $state<string | null>(null);
	let isSaving = $state(false);
	let volumePercent = $derived(Math.round(ls.completionSoundVolume * 100));

	const modeLabels: Record<CompletionSoundMode, () => string> = {
		off: m.settings_completion_sound_off,
		default: m.settings_completion_sound_default,
		custom: m.settings_completion_sound_custom,
	};
	const visibilityLabels: Record<CompletionSoundVisibility, () => string> = {
		always: m.settings_completion_sound_always,
		unfocused: m.settings_completion_sound_unfocused,
	};

	function setMode(value: string): void {
		if (!COMPLETION_SOUND_MODE_VALUES.includes(value as CompletionSoundMode)) return;
		ls.set('completionSoundMode', value as CompletionSoundMode);
	}

	function setVisibility(value: string): void {
		if (!COMPLETION_SOUND_VISIBILITY_VALUES.includes(value as CompletionSoundVisibility)) return;
		ls.set('completionSoundVisibility', value as CompletionSoundVisibility);
	}

	function validationMessage(code: string): string {
		if (code === 'empty') return m.settings_completion_sound_error_empty();
		if (code === 'too-large') return m.settings_completion_sound_error_too_large();
		if (code === 'unsupported-type') return m.settings_completion_sound_error_type();
		return m.settings_completion_sound_error_save();
	}

	async function uploadCustomSound(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const validationError = validateCustomCompletionSound(file);
		if (validationError) {
			uploadError = validationMessage(validationError);
			return;
		}

		uploadError = null;
		isSaving = true;
		try {
			await storeCustomCompletionSound(file);
			ls.set('customCompletionSoundName', file.name);
			ls.set('completionSoundMode', 'custom');
		} catch {
			uploadError = validationMessage('save');
		} finally {
			isSaving = false;
		}
	}

	async function removeCustomSound(): Promise<void> {
		uploadError = null;
		isSaving = true;
		try {
			await removeCustomCompletionSound();
			ls.set('customCompletionSoundName', null);
			if (ls.completionSoundMode === 'custom') ls.set('completionSoundMode', 'off');
		} catch {
			uploadError = m.settings_completion_sound_error_remove();
		} finally {
			isSaving = false;
		}
	}

	function testSound(): void {
		const mode = ls.completionSoundMode === 'custom' ? 'custom' : 'default';
		void playCompletionSound(
			{ mode, volume: ls.completionSoundVolume, visibility: 'always' },
			{ force: true },
		);
	}
</script>

<div class="mt-2 border-t border-border pb-1 pt-2">
	<h3 class="py-2 text-sm font-medium text-foreground">{m.settings_completion_sound_title()}</h3>
	<p class="pb-2 text-xs text-muted-foreground">{m.settings_completion_sound_description()}</p>

	<div class="flex items-center justify-between gap-4 py-2">
		<label class="text-sm font-medium text-foreground" for="completion-sound-mode">
			{m.settings_completion_sound_label()}
		</label>
		<select
			id="completion-sound-mode"
			class="w-36 rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground"
			value={ls.completionSoundMode}
			onchange={(event) => setMode((event.currentTarget as HTMLSelectElement).value)}
		>
			{#each COMPLETION_SOUND_MODE_VALUES as mode (mode)}
				<option value={mode} disabled={mode === 'custom' && !ls.customCompletionSoundName}>
					{modeLabels[mode]()}
				</option>
			{/each}
		</select>
	</div>

	<div class="flex items-center justify-between gap-4 py-2">
		<div class="min-w-0">
			<div class="text-sm font-medium text-foreground">
				{m.settings_completion_sound_custom_file()}
			</div>
			<div class="mt-0.5 truncate text-xs text-muted-foreground">
				{ls.customCompletionSoundName ?? m.settings_completion_sound_no_file()}
			</div>
		</div>
		<div class="flex shrink-0 gap-2">
			<input
				bind:this={fileInput}
				type="file"
				accept={CUSTOM_COMPLETION_SOUND_ACCEPT}
				class="sr-only"
				onchange={uploadCustomSound}
				aria-label={m.settings_completion_sound_upload()}
			/>
			<Button variant="outline" size="sm" disabled={isSaving} onclick={() => fileInput?.click()}>
				{m.settings_completion_sound_upload()}
			</Button>
			{#if ls.customCompletionSoundName}
				<Button variant="ghost" size="sm" disabled={isSaving} onclick={removeCustomSound}>
					{m.settings_completion_sound_remove()}
				</Button>
			{/if}
		</div>
	</div>

	{#if uploadError}
		<p class="py-1 text-xs text-destructive" role="alert">{uploadError}</p>
	{/if}

	<div class="flex items-center justify-between gap-4 py-2">
		<label class="text-sm font-medium text-foreground" for="completion-sound-volume">
			{m.settings_completion_sound_volume({ percent: volumePercent })}
		</label>
		<input
			id="completion-sound-volume"
			type="range"
			min="0"
			max="1"
			step="0.05"
			value={ls.completionSoundVolume}
			disabled={ls.completionSoundMode === 'off'}
			oninput={(event) =>
				ls.set('completionSoundVolume', Number((event.currentTarget as HTMLInputElement).value))}
			class="w-36 accent-primary"
		/>
	</div>

	<div class="flex items-center justify-between gap-4 py-2">
		<label class="text-sm font-medium text-foreground" for="completion-sound-visibility">
			{m.settings_completion_sound_when()}
		</label>
		<select
			id="completion-sound-visibility"
			class="w-48 max-w-[55%] rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground"
			value={ls.completionSoundVisibility}
			disabled={ls.completionSoundMode === 'off'}
			onchange={(event) => setVisibility((event.currentTarget as HTMLSelectElement).value)}
		>
			{#each COMPLETION_SOUND_VISIBILITY_VALUES as visibility (visibility)}
				<option value={visibility}>{visibilityLabels[visibility]()}</option>
			{/each}
		</select>
	</div>

	<div class="flex justify-end py-2">
		<Button
			variant="outline"
			size="sm"
			disabled={ls.completionSoundMode === 'custom' && !ls.customCompletionSoundName}
			onclick={testSound}
		>
			{m.settings_completion_sound_test()}
		</Button>
	</div>
</div>
