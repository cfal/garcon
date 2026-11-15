<script lang="ts">
	import { tick } from 'svelte';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import { Button } from '$lib/components/ui/button';
	import { SIDEBAR_INACTIVITY_DURATION_VALUES } from '$lib/stores/local-settings.svelte';
	import type { SidebarGroupingField } from '$lib/sidebar/display/sidebar-preferences';
	import type { SidebarDisplayPreferences } from '$lib/sidebar/display/sidebar-display-options';
	import * as m from '$lib/paraglide/messages.js';

	let {
		value,
		onChange,
	}: {
		value: SidebarDisplayPreferences;
		onChange: (value: SidebarDisplayPreferences) => void;
	} = $props();
	let announcement = $state('');
	const labels: Record<SidebarGroupingField, () => string> = {
		executor: m.sidebar_group_executor,
		project: m.sidebar_group_project,
		activity: m.sidebar_group_activity,
		status: m.sidebar_group_status,
	};
	const durations = {
		'2-days': m.settings_sidebar_inactivity_duration_2_days,
		'3-days': m.settings_sidebar_inactivity_duration_3_days,
		'4-days': m.settings_sidebar_inactivity_duration_4_days,
		'5-days': m.settings_sidebar_inactivity_duration_5_days,
		'1-week': m.settings_sidebar_inactivity_duration_1_week,
		'2-weeks': m.settings_sidebar_inactivity_duration_2_weeks,
		'1-month': m.settings_sidebar_inactivity_duration_1_month,
		'2-months': m.settings_sidebar_inactivity_duration_2_months,
		'3-months': m.settings_sidebar_inactivity_duration_3_months,
	};
	const layouts = [
		{ value: 'single-line', label: m.settings_sidebar_chat_item_layout_single_line },
		{ value: 'compact', label: m.settings_sidebar_compact_chat_items },
		{ value: 'detailed', label: m.settings_sidebar_chat_item_layout_detailed },
	] as const;
	async function move(index: number, offset: number, button: HTMLElement) {
		const fields = [...value.sidebarGroupingFields];
		const target = index + offset;
		if (target < 0 || target >= fields.length) return;
		[fields[index], fields[target]] = [fields[target], fields[index]];
		onChange({ ...value, sidebarGroupingFields: fields });
		announcement = m.sidebar_group_moved({
			field: labels[fields[target].field](),
			position: target + 1,
		});
		await tick();
		if (button.hasAttribute('disabled'))
			button.closest('[data-grouping-field]')?.querySelector<HTMLInputElement>('input')?.focus();
		else button.focus();
	}
</script>

<div class="min-w-0 space-y-5">
	<label class="flex min-h-11 items-center gap-3 text-sm">
		<input
			type="checkbox"
			class="size-4"
			checked={value.sidebarNestDelegatedChats}
			onchange={(event) =>
				onChange({ ...value, sidebarNestDelegatedChats: event.currentTarget.checked })}
		/>
		{m.sidebar_nest_delegated_chats()}
	</label>
	<fieldset>
		<legend class="mb-2 text-sm font-medium">{m.sidebar_group_heading()}</legend>
		{#each value.sidebarGroupingFields as entry, index (entry.field)}
			<div
				class="flex min-h-11 items-center gap-2 border-b border-border/60"
				data-grouping-field={entry.field}
			>
				<label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm">
					<input
						type="checkbox"
						class="size-4"
						checked={entry.enabled}
						onchange={(event) =>
							onChange({
								...value,
								sidebarGroupingFields: value.sidebarGroupingFields.map((field) =>
									field.field === entry.field
										? { ...field, enabled: event.currentTarget.checked }
										: field,
								),
							})}
					/>
					<span class="w-4 text-right tabular-nums text-muted-foreground" aria-hidden="true"
						>{index + 1}</span
					>
					<span>{labels[entry.field]()}</span>
				</label>
				<Button
					variant="ghost"
					size="icon"
					disabled={index === 0}
					aria-label={m.sidebar_group_move_up({ field: labels[entry.field]() })}
					title={m.sidebar_group_move_up({ field: labels[entry.field]() })}
					onclick={(event) => move(index, -1, event.currentTarget)}
					><ArrowUp class="size-4" /></Button
				>
				<Button
					variant="ghost"
					size="icon"
					disabled={index === value.sidebarGroupingFields.length - 1}
					aria-label={m.sidebar_group_move_down({ field: labels[entry.field]() })}
					title={m.sidebar_group_move_down({ field: labels[entry.field]() })}
					onclick={(event) => move(index, 1, event.currentTarget)}
					><ArrowDown class="size-4" /></Button
				>
			</div>
		{/each}
		<label class="mt-3 flex min-h-11 items-center gap-3 text-sm">
			<input
				type="checkbox"
				class="size-4"
				disabled={!value.sidebarGroupingFields.some(
					(field) => field.field === 'project' && field.enabled,
				)}
				checked={value.sidebarGroupNestedProjectPaths}
				onchange={(event) =>
					onChange({ ...value, sidebarGroupNestedProjectPaths: event.currentTarget.checked })}
			/>
			{m.settings_sidebar_group_nested_project_paths()}
		</label>
		<label class="mt-2 flex flex-col gap-2 text-sm">
			{m.settings_sidebar_inactivity_duration()}
			<select
				class="select-native select-native-surface h-11 w-full text-base"
				disabled={!value.sidebarGroupingFields.some(
					(field) => field.field === 'activity' && field.enabled,
				)}
				value={value.sidebarInactivityDuration}
				onchange={(event) => {
					const duration = SIDEBAR_INACTIVITY_DURATION_VALUES.find(
						(duration) => duration === event.currentTarget.value,
					);
					if (duration) onChange({ ...value, sidebarInactivityDuration: duration });
				}}
			>
				{#each SIDEBAR_INACTIVITY_DURATION_VALUES as duration (duration)}<option value={duration}
						>{durations[duration]()}</option
					>{/each}
			</select>
		</label>
	</fieldset>
	<fieldset>
		<legend class="mb-2 text-sm font-medium">{m.settings_sidebar_chat_item_layout_heading()}</legend
		>
		<div class="flex rounded-md border border-input p-1">
			{#each layouts as layout (layout.value)}
				<label
					class="relative flex min-h-10 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-sm px-2 text-sm has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
				>
					<input
						type="radio"
						class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
						name="sidebar-display-layout"
						checked={value.sidebarChatItemLayout === layout.value}
						onchange={() => onChange({ ...value, sidebarChatItemLayout: layout.value })}
					/>{layout.label()}
				</label>
			{/each}
		</div>
		<label class="mt-2 flex min-h-11 items-center gap-3 text-sm"
			><input
				type="checkbox"
				class="size-4"
				checked={value.sidebarShowProjectPath}
				onchange={(event) =>
					onChange({ ...value, sidebarShowProjectPath: event.currentTarget.checked })}
			/>{m.settings_sidebar_show_project_path()}</label
		>
	</fieldset>
</div>
<span class="sr-only" aria-live="polite">{announcement}</span>
