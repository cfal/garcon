<script lang="ts">
	import { getLocalSettings, getOptionalTransientLayers } from '$lib/context';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import * as m from '$lib/paraglide/messages.js';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
	import {
		COMPOSER_SHORTCUTS,
		CONFIGURABLE_SHORTCUTS,
		GLOBAL_SHORTCUTS,
		SLASH_COMMANDS,
		type ShortcutEntry,
	} from './keyboard-shortcut-entries.js';
	import {
		assignGlobalShortcut,
		disableGlobalShortcut,
		formatGlobalShortcut,
		getEffectiveGlobalShortcut,
		globalShortcutBindingFromEvent,
		isSafeGlobalShortcutBinding,
		resetGlobalShortcut,
		type GlobalShortcutBinding,
		type GlobalShortcutId,
	} from '$lib/workspace/global-shortcuts.js';

	const ls = getLocalSettings();
	const transientLayers = getOptionalTransientLayers();
	const recordingLayerId = allocateTransientLayerId('shortcut-recording');
	const sendMessageKeys = $derived(ls.sendByShiftEnter ? ['Shift', 'Enter'] : ['Enter']);
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	let recordingId = $state<GlobalShortcutId | null>(null);
	let feedback = $state<string | null>(null);
	let sectionElement = $state<HTMLElement | null>(null);

	// Recording claims a transient layer so Escape cancels the capture. Without it
	// the workspace dispatcher sees Escape first and closes the settings dialog.
	$effect(() => {
		if (!transientLayers || !recordingId || !sectionElement) return;
		return transientLayers.register({
			id: recordingLayerId,
			kind: 'popover',
			modality: 'nonmodal',
			element: () => sectionElement,
			onEscape: () => {
				recordingId = null;
				return true;
			},
			restoreFocus: () => undefined,
		});
	});

	function shortcutLabel(id: GlobalShortcutId): string {
		return CONFIGURABLE_SHORTCUTS.find((entry) => entry.id === id)?.label() ?? id;
	}

	function startRecording(id: GlobalShortcutId): void {
		recordingId = id;
		feedback = null;
	}

	// Losing focus abandons the capture so the control cannot stay armed while unfocused.
	function stopRecording(id: GlobalShortcutId): void {
		if (recordingId === id) recordingId = null;
	}

	function reportAssignment(
		binding: GlobalShortcutBinding,
		unassignedId: GlobalShortcutId | null,
	): void {
		feedback = unassignedId
			? m.settings_shortcut_conflict_reassigned({
					shortcut: formatGlobalShortcut(binding, isMac).join('+'),
					command: shortcutLabel(unassignedId),
				})
			: null;
	}

	function handleBindingKeydown(event: KeyboardEvent, id: GlobalShortcutId): void {
		if (recordingId !== id) return;
		event.preventDefault();
		event.stopPropagation();

		const binding = globalShortcutBindingFromEvent(event);
		if (!binding) return;
		if (!isSafeGlobalShortcutBinding(binding)) {
			feedback = m.settings_shortcut_modifier_required();
			return;
		}

		const result = assignGlobalShortcut(ls.globalShortcuts, id, binding);
		ls.set('globalShortcuts', result.overrides);
		recordingId = null;
		reportAssignment(binding, result.unassignedId);
	}

	function removeShortcut(id: GlobalShortcutId): void {
		ls.set('globalShortcuts', disableGlobalShortcut(ls.globalShortcuts, id));
		recordingId = null;
		feedback = null;
	}

	function resetShortcut(id: GlobalShortcutId): void {
		const result = resetGlobalShortcut(ls.globalShortcuts, id);
		ls.set('globalShortcuts', result.overrides);
		recordingId = null;
		const binding = getEffectiveGlobalShortcut(id, result.overrides);
		if (binding) reportAssignment(binding, result.unassignedId);
	}
</script>

{#snippet keyCombo(keys: string[])}
	<span class="flex items-center gap-1">
		{#each keys as key, index (index)}
			{#if index > 0}
				<span class="text-xs text-muted-foreground">+</span>
			{/if}
			<kbd
				class="px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
			>
				{key}
			</kbd>
		{/each}
	</span>
{/snippet}

{#snippet shortcutRow(label: string, keys: string[])}
	<div class="flex items-center justify-between gap-4 py-2">
		<div class="text-sm font-medium text-foreground">{label}</div>
		{@render keyCombo(keys)}
	</div>
{/snippet}

{#snippet preferenceRow(label: string, checked: boolean, onToggle: () => void)}
	<div class="flex items-center justify-between gap-4 py-2">
		<div class="text-sm font-medium text-foreground">{label}</div>
		<Switch {checked} onCheckedChange={onToggle} aria-label={label} />
	</div>
{/snippet}

{#snippet configurableShortcutRow(entry: ShortcutEntry)}
	{@const binding = getEffectiveGlobalShortcut(entry.id, ls.globalShortcuts)}
	{@const hasOverride = Object.hasOwn(ls.globalShortcuts, entry.id)}
	<div
		class="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
		role="group"
		aria-label={entry.label()}
	>
		<div class="min-w-0">
			<div class="text-sm font-medium text-foreground">{entry.label()}</div>
			<div class="mt-0.5 text-xs text-muted-foreground">
				{#if binding === null}
					{m.settings_shortcut_disabled()}
				{:else if hasOverride}
					{m.settings_shortcut_custom()}
				{:else}
					{m.settings_shortcut_system_default()}
				{/if}
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button
				variant={recordingId === entry.id ? 'default' : 'outline'}
				size="sm"
				class="min-w-28 font-mono"
				onclick={() => startRecording(entry.id)}
				onkeydown={(event) => handleBindingKeydown(event, entry.id)}
				onblur={() => stopRecording(entry.id)}
				aria-label={m.settings_shortcut_change_aria({ command: entry.label() })}
			>
				{#if recordingId === entry.id}
					{m.settings_shortcut_press_keys()}
				{:else if binding}
					{@render keyCombo(formatGlobalShortcut(binding, isMac))}
				{:else}
					{m.settings_shortcut_unassigned()}
				{/if}
			</Button>
			<Button
				variant="ghost"
				size="sm"
				disabled={binding === null}
				onclick={() => removeShortcut(entry.id)}
			>
				{m.settings_shortcut_remove()}
			</Button>
			<Button
				variant="ghost"
				size="sm"
				disabled={!hasOverride}
				onclick={() => resetShortcut(entry.id)}
			>
				{m.settings_shortcut_reset()}
			</Button>
		</div>
	</div>
{/snippet}

<div class="space-y-6" bind:this={sectionElement}>
	{#if feedback}
		<div
			class="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
			role="status"
		>
			{feedback}
		</div>
	{/if}
	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_composer()}
		</h3>
		<div class="divide-y divide-border rounded-lg border border-border bg-muted/50 px-4 py-1">
			{@render preferenceRow(m.settings_chat_send_by_shift_enter(), ls.sendByShiftEnter, () =>
				ls.toggle('sendByShiftEnter'),
			)}
			{@render preferenceRow(
				m.settings_shortcut_steer_with_ctrl_enter(),
				ls.steerWithCtrlEnter,
				() => ls.toggle('steerWithCtrlEnter'),
			)}
			{@render shortcutRow(m.settings_shortcut_send_message(), sendMessageKeys)}
			{#each COMPOSER_SHORTCUTS as entry (entry.id)}
				{@render configurableShortcutRow(entry)}
			{/each}
		</div>
	</section>

	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_global()}
		</h3>
		<p class="text-xs text-muted-foreground">{m.settings_shortcuts_edit_hint()}</p>
		<div class="divide-y divide-border rounded-lg border border-border bg-muted/50">
			{#each GLOBAL_SHORTCUTS as entry (entry.id)}
				<div class="px-4">
					{@render configurableShortcutRow(entry)}
				</div>
			{/each}
		</div>
	</section>

	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_slash_commands()}
		</h3>
		<div class="bg-muted/50 border border-border rounded-lg px-4 py-1">
			{#each SLASH_COMMANDS as entry (entry.command)}
				<div
					class="flex flex-col items-start gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
				>
					<div class="text-sm text-muted-foreground">{entry.description()}</div>
					<code
						class="max-w-full whitespace-nowrap px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
					>
						{entry.command}
					</code>
				</div>
			{/each}
		</div>
	</section>
</div>
