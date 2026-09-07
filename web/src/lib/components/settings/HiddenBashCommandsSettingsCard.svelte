<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn.js';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { getRemoteSettings } from '$lib/context';
	import {
		dedupeHiddenBashCommandPatterns,
		HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
		HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH,
		HIDDEN_BASH_COMMAND_PATTERN_PRESETS,
		HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES,
		validateHiddenBashCommandPattern,
		type HiddenBashCommandPattern,
		type HiddenBashCommandPatternMode,
		type HiddenBashCommandPatternPreset,
		type HiddenBashCommandPatternValidation,
	} from '$lib/chat/transcript/hidden-bash-commands.js';

	type PatternValidationError = Exclude<HiddenBashCommandPatternValidation, 'ok'>;

	const remoteSettings = getRemoteSettings();

	let draft = $state('');
	let mode = $state<HiddenBashCommandPatternMode>('glob');
	let isSaving = $state(false);
	let validationError = $state<string | null>(null);
	let saveError = $state<string | null>(null);

	const patterns = $derived(remoteSettings.snapshot?.ui.hiddenBashCommandPatterns ?? []);
	const errorText = $derived(validationError ?? saveError);

	function validationErrorText(validation: PatternValidationError): string {
		switch (validation) {
			case 'empty':
				return m.settings_hidden_bash_commands_error_empty();
			case 'too-long':
				return m.settings_hidden_bash_commands_error_too_long({
					maxLength: HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH,
				});
			case 'invalid-regex':
				return m.settings_hidden_bash_commands_error_invalid_regex();
		}
	}

	async function persistPatterns(next: readonly HiddenBashCommandPattern[]): Promise<boolean> {
		if (isSaving) return false;
		isSaving = true;
		saveError = null;
		try {
			await remoteSettings.update({
				ui: { hiddenBashCommandPatterns: dedupeHiddenBashCommandPatterns(next) },
			});
			return true;
		} catch (error) {
			saveError = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		} finally {
			isSaving = false;
		}
	}

	async function addPattern(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (isSaving) return;
		saveError = null;
		const validation = validateHiddenBashCommandPattern(draft, mode);
		if (validation !== 'ok') {
			validationError = validationErrorText(validation);
			return;
		}
		if (patterns.some((entry) => entry.pattern === draft && entry.mode === mode)) {
			validationError = m.settings_hidden_bash_commands_error_duplicate();
			return;
		}
		if (patterns.length >= HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT) {
			validationError = null;
			saveError = m.settings_hidden_bash_commands_error_limit({
				maxCount: HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
			});
			return;
		}
		validationError = null;
		if (await persistPatterns([...patterns, { pattern: draft, mode }])) {
			draft = '';
		}
	}

	async function removePattern(pattern: HiddenBashCommandPattern): Promise<void> {
		if (isSaving) return;
		validationError = null;
		await persistPatterns(
			patterns.filter(
				(entry) => entry.pattern !== pattern.pattern || entry.mode !== pattern.mode,
			),
		);
	}

	async function addPreset(preset: HiddenBashCommandPatternPreset): Promise<void> {
		if (isSaving) return;
		validationError = null;
		saveError = null;
		const next = dedupeHiddenBashCommandPatterns([...patterns, ...preset.patterns]);
		if (next.length === patterns.length) return;
		if (next.length > HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT) {
			saveError = m.settings_hidden_bash_commands_error_limit({
				maxCount: HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
			});
			return;
		}
		await persistPatterns(next);
	}

	function presetLabel(preset: HiddenBashCommandPatternPreset): string {
		switch (preset.id) {
			case 'garcon-amp':
				return m.settings_hidden_bash_commands_preset_garcon_amp();
		}
	}

	function modeLabel(mode: HiddenBashCommandPatternMode): string {
		return mode === 'regex'
			? m.settings_hidden_bash_commands_mode_regex()
			: m.settings_hidden_bash_commands_mode_glob();
	}
</script>

<div class="border border-border bg-muted/50 rounded-lg px-4 py-3 space-y-3">
	<div class="flex items-center justify-between gap-3">
		<div class="text-sm font-medium text-foreground">{m.settings_hidden_bash_commands_title()}</div>
		<DropdownMenu>
			<DropdownMenuTrigger
				class={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
				aria-label={m.settings_hidden_bash_commands_add_preset()}
				title={m.settings_hidden_bash_commands_add_preset()}
				disabled={isSaving}
			>
				<PlusIcon class="mr-2 size-4" />
				{m.settings_hidden_bash_commands_add_preset()}
				<ChevronDownIcon class="ml-1 size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{#each HIDDEN_BASH_COMMAND_PATTERN_PRESETS as preset (preset.id)}
					<DropdownMenuItem onclick={() => addPreset(preset)} disabled={isSaving}>
						{presetLabel(preset)}
					</DropdownMenuItem>
				{/each}
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
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
							disabled={isSaving}
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
				aria-invalid={validationError !== null}
				readonly={isSaving}
				oninput={() => (validationError = null)}
			/>
			<select
				class="rounded-md border border-border bg-muted px-2 py-1 text-base text-foreground sm:pointer-fine:text-sm"
				aria-label={m.settings_hidden_bash_commands_mode_label()}
				bind:value={mode}
				disabled={isSaving}
				onchange={() => (validationError = null)}
			>
				{#each HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES as modeValue (modeValue)}
					<option value={modeValue}>{modeLabel(modeValue)}</option>
				{/each}
			</select>
			<Button type="submit" variant="secondary" size="sm" disabled={isSaving}>
				{m.settings_hidden_bash_commands_add()}
			</Button>
		</div>
		{#if errorText}
			<p class="text-xs text-destructive" role="alert">{errorText}</p>
		{/if}
	</form>
</div>
