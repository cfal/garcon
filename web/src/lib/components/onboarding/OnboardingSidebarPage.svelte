<script lang="ts">
	import { getLocalSettings, getRemoteSettings } from '$lib/context';
	import SidebarDisplayFields from '../sidebar/SidebarDisplayFields.svelte';
	import SidebarDisplayPreview from '../sidebar/SidebarDisplayPreview.svelte';
	import { typographyScale } from '$lib/theme/typography';
	import * as m from '$lib/paraglide/messages.js';
	const settings = getLocalSettings();
	const remote = getRemoteSettings();
	const preferences = $derived({
		sidebarGroupingFields: settings.sidebarGroupingFields,
		sidebarInactivityDuration: settings.sidebarInactivityDuration,
		sidebarGroupNestedProjectPaths: settings.sidebarGroupNestedProjectPaths,
		sidebarChatItemLayout: settings.sidebarChatItemLayout,
		sidebarShowProjectPath: settings.sidebarShowProjectPath,
	});
	const options = $derived({
		groupingFields: preferences.sidebarGroupingFields,
		inactivityDuration: preferences.sidebarInactivityDuration,
		groupNestedProjectPaths: preferences.sidebarGroupNestedProjectPaths,
		chatItemLayout: preferences.sidebarChatItemLayout,
		showProjectPath: preferences.sidebarShowProjectPath,
		nestDelegatedChats: settings.sidebarNestDelegatedChats,
		sortMode: settings.sidebarSortMode,
		pinnedInsertPosition: remote.snapshot?.ui?.pinnedInsertPosition ?? 'top',
		chatFontScale: typographyScale('chat-list', settings.chatListFontSize),
	});
</script>

<div class="grid min-w-0 gap-5 sm:grid-cols-2">
	<SidebarDisplayFields value={preferences} onChange={(next) => settings.setSidebarDisplay(next)} />
	<SidebarDisplayPreview {options} width={settings.sidebarWidth} />
</div>
<div class="mt-4 border-t border-border pt-2">
	<label
		class="flex min-h-11 cursor-pointer items-center justify-between gap-4 text-sm font-medium"
	>
		{m.sidebar_actions_dock_sidebar_right()}
		<input
			type="checkbox"
			class="size-4"
			checked={settings.chatListDock === 'right'}
			onchange={(event) =>
				settings.set('chatListDock', event.currentTarget.checked ? 'right' : 'left')}
		/>
	</label>
</div>
