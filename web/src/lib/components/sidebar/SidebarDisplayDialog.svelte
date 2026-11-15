<script lang="ts">
	import { getLocalSettings, getRemoteSettings } from '$lib/context';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import SidebarDisplayFields from './SidebarDisplayFields.svelte';
	import SidebarDisplayPreview from './SidebarDisplayPreview.svelte';
	import { defaultSidebarGroupingFields } from '$lib/sidebar/display/sidebar-preferences';
	import { typographyScale } from '$lib/theme/typography';
	import * as m from '$lib/paraglide/messages.js';
	let { onClose }: { onClose: () => void } = $props();
	const settings = getLocalSettings();
	const remote = getRemoteSettings();
	let draft = $state({
		sidebarGroupingFields: settings.sidebarGroupingFields.map((field) => ({ ...field })),
		sidebarInactivityDuration: settings.sidebarInactivityDuration,
		sidebarGroupNestedProjectPaths: settings.sidebarGroupNestedProjectPaths,
		sidebarChatItemLayout: settings.sidebarChatItemLayout,
		sidebarShowProjectPath: settings.sidebarShowProjectPath,
	});
	const preview = $derived({
		groupingFields: draft.sidebarGroupingFields,
		inactivityDuration: draft.sidebarInactivityDuration,
		groupNestedProjectPaths: draft.sidebarGroupNestedProjectPaths,
		chatItemLayout: draft.sidebarChatItemLayout,
		showProjectPath: draft.sidebarShowProjectPath,
		nestDelegatedChats: settings.sidebarNestDelegatedChats,
		sortMode: settings.sidebarSortMode,
		pinnedInsertPosition: remote.snapshot?.ui?.pinnedInsertPosition ?? 'top',
		chatFontScale: typographyScale('chat-list', settings.chatListFontSize),
	});
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content class="flex max-h-[90dvh] flex-col sm:max-w-3xl" aria-describedby={undefined}>
		<Dialog.Header><Dialog.Title>{m.sidebar_display_title()}</Dialog.Title></Dialog.Header>
		<div class="grid min-h-0 gap-6 overflow-y-auto sm:grid-cols-2">
			<SidebarDisplayFields value={draft} onChange={(next) => (draft = next)} />
			<SidebarDisplayPreview options={preview} width={settings.sidebarWidth} />
		</div>
		<Dialog.Footer class="shrink-0 border-t border-border pt-3">
			<Button
				variant="ghost"
				class="sm:mr-auto"
				onclick={() =>
					(draft = {
						sidebarGroupingFields: defaultSidebarGroupingFields(),
						sidebarInactivityDuration: '3-days',
						sidebarGroupNestedProjectPaths: false,
						sidebarChatItemLayout: 'single-line',
						sidebarShowProjectPath: false,
					})}>{m.sidebar_display_reset()}</Button
			>
			<Button variant="outline" onclick={onClose}>{m.sidebar_actions_cancel()}</Button>
			<Button
				onclick={() => {
					settings.setSidebarDisplay(draft);
					onClose();
				}}>{m.sidebar_display_apply()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
