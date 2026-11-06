<script lang="ts">
	import { getLocalSettings } from '$lib/context';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import {
		SIDEBAR_CHAT_GROUPING_VALUES,
		type SidebarChatGrouping,
		type SidebarSortMode,
	} from '$lib/stores/local-settings.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import { ONBOARDING_OPTION_CARD_CLASS } from './onboarding-option-card.js';
	import OnboardingChatLayoutPreview from './OnboardingChatLayoutPreview.svelte';

	const ls = getLocalSettings();
	const layoutOptions: Array<{ value: ChatItemLayout; label: () => string; hint: () => string }> = [
		{
			value: 'single-line',
			label: m.onboarding_layout_single_line,
			hint: m.onboarding_layout_single_line_hint,
		},
		{
			value: 'compact',
			label: m.onboarding_layout_compact,
			hint: m.onboarding_layout_compact_hint,
		},
		{
			value: 'detailed',
			label: m.onboarding_layout_detailed,
			hint: m.onboarding_layout_detailed_hint,
		},
	];
	const groupingLabels: Record<SidebarChatGrouping, () => string> = {
		none: m.settings_sidebar_grouping_none,
		project: m.settings_sidebar_group_by_project,
		'project-and-activity': m.settings_sidebar_group_by_project_activity,
		activity: m.settings_sidebar_group_by_activity,
		status: m.settings_sidebar_group_by_status,
	};
	const sortOptions: Array<{ value: SidebarSortMode; label: () => string }> = [
		{ value: 'recent', label: m.sidebar_chats_sort_recent_active },
		{ value: 'manual', label: m.sidebar_chats_sort_order_manual },
	];
</script>

<fieldset class="grid grid-cols-1 gap-3 sm:grid-cols-3">
	<legend class="sr-only">{m.onboarding_layout_title()}</legend>
	{#each layoutOptions as option (option.value)}
		<label class={ONBOARDING_OPTION_CARD_CLASS}>
			<input
				type="radio"
				class="sr-only"
				name="onboarding-layout"
				value={option.value}
				checked={ls.sidebarChatItemLayout === option.value}
				onchange={() => ls.set('sidebarChatItemLayout', option.value)}
			/>
			<div class="flex w-full flex-1 items-center">
				<OnboardingChatLayoutPreview
					layout={option.value}
					isSelected={ls.sidebarChatItemLayout === option.value}
				/>
			</div>
			<span class="flex flex-col items-center gap-1">
				<span class="text-sm font-medium text-foreground">{option.label()}</span>
				<span class="text-xs text-muted-foreground">{option.hint()}</span>
			</span>
		</label>
	{/each}
</fieldset>

<div class="mt-5 grid gap-4 sm:grid-cols-2">
	<label class="flex min-w-0 flex-col gap-2 text-sm font-medium">
		{m.settings_sidebar_chat_grouping_heading()}
		<select
			class="select-native select-native-surface h-10 w-full"
			value={ls.sidebarGrouping}
			onchange={(event) => {
				const value = event.currentTarget.value;
				const grouping = SIDEBAR_CHAT_GROUPING_VALUES.find((candidate) => candidate === value);
				if (grouping) ls.set('sidebarGrouping', grouping);
			}}
		>
			{#each SIDEBAR_CHAT_GROUPING_VALUES as grouping (grouping)}
				<option value={grouping}>{groupingLabels[grouping]()}</option>
			{/each}
		</select>
	</label>
	<fieldset class="min-w-0">
		<legend class="mb-2 text-sm font-medium">{m.sidebar_chats_sort_order_heading()}</legend>
		<div class="flex min-h-10 rounded-md border border-input p-1">
			{#each sortOptions as option (option.value)}
				<label
					class="flex min-w-0 flex-1 cursor-pointer items-center justify-center rounded-sm px-2 text-sm has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
				>
					<input
						type="radio"
						class="sr-only"
						name="onboarding-sort"
						value={option.value}
						checked={ls.sidebarSortMode === option.value}
						onchange={() => ls.set('sidebarSortMode', option.value)}
					/>
					{option.label()}
				</label>
			{/each}
		</div>
	</fieldset>
</div>
