<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { getLocalSettings } from '$lib/context';
	import {
		HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES,
		validateHiddenBashCommandPattern,
		type HiddenBashCommandPattern,
		type HiddenBashCommandPatternMode,
		type HiddenBashCommandPatternValidation,
	} from '$lib/chat/transcript/hidden-bash-commands.js';

	type PatternValidationError = Exclude<HiddenBashCommandPatternValidation, 'ok'>;

	const localSettings = getLocalSettings();

	let draft = $state('');
	let mode = $state<HiddenBashCommandPatternMode>('glob');
	let error = $state<string | null>(null);

	const patterns = $derived(localSettings.hiddenBashCommandPatterns);

	function validationErrorText(validation: PatternValidationError): string {
		switch (validation) {
			case 'empty':
				return m.settings_hidden_bash_commands_error_empty();
			case 'invalid-regex':
				return m.settings_hidden_bash_commands_error_invalid_regex();
		}
	}

	function addPattern(event: SubmitEvent) {
		event.preventDefault();
		const validation = validateHiddenBashCommandPattern(draft, mode);
		if (validation !== 'ok') {
			error = validationErrorText(validation);
			return;
		}
		if (patterns.some((entry) => entry.pattern === draft && entry.mode === mode)) {
			error = m.settings_hidden_bash_commands_error_duplicate();
			return;
		}
		localSettings.addHiddenBashCommandPattern({ pattern: draft, mode });
		draft = '';
		error = null;
	}

	function removePattern(pattern: HiddenBashCommandPattern) {
		localSettings.removeHiddenBashCommandPattern(pattern);
	}

	function modeLabel(mode: HiddenBashCommandPatternMode): string {
		return mode === 'regex'
			? m.settings_hidden_bash_commands_mode_regex()
			: m.settings_hidden_bash_commands_mode_glob();
	}
</script>

<div class="border border-border bg-muted/50 rounded-lg px-4 py-3 space-y-3">
	<div class="text-sm font-medium text-foreground">{m.settings_hidden_bash_commands_title()}</div>
	<div class="text-xs text-muted-foreground">
		{m.settings_hidden_bash_commands_description()}
	</div>

	{#if patterns.length > 0}
		<ul class="space-y-1" data-testid="hidden-bash-command-patterns">
			{#each patterns as pattern (pattern.mode + ':' + pattern.pattern)}
				<li
					class="flex items-center justify-between gap-2 rounded-md border border-border bg-background/50 px-2 py-1"
				>
					<span class="min-w-0 truncate font-mono text-sm text-foreground" title={pattern.pattern}>
						{pattern.pattern}
					</span>
					<span class="flex shrink-0 items-center gap-2">
						<span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
							{modeLabel(pattern.mode)}
						</span>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`${m.settings_hidden_bash_commands_remove()}: ${pattern.pattern} (${modeLabel(pattern.mode)})`}
							onclick={() => removePattern(pattern)}
						>
							<TrashIcon class="size-4" />
						</Button>
					</span>
				</li>
			{/each}
		</ul>
	{/if}

	<form class="flex flex-col gap-1" onsubmit={addPattern}>
		<div class="flex items-center gap-2">
			<input
				type="text"
				class="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1 font-mono text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				aria-label={m.settings_hidden_bash_commands_pattern_label()}
				autocapitalize="off"
				autocomplete="off"
				spellcheck="false"
				bind:value={draft}
				aria-invalid={error !== null}
				oninput={() => (error = null)}
			/>
			<select
				class="rounded-md border border-border bg-muted px-2 py-1 text-base text-foreground sm:pointer-fine:text-sm"
				aria-label={m.settings_hidden_bash_commands_mode_label()}
				bind:value={mode}
				onchange={() => (error = null)}
			>
				{#each HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES as modeValue (modeValue)}
					<option value={modeValue}>{modeLabel(modeValue)}</option>
				{/each}
			</select>
			<Button type="submit" variant="secondary" size="sm">
				{m.settings_hidden_bash_commands_add()}
			</Button>
		</div>
		{#if error}
			<p class="text-xs text-destructive" role="alert">{error}</p>
		{/if}
	</form>
</div>
