<script lang="ts">
	import { tick } from 'svelte';
	import { getLocalSettings, getRemoteSettings } from '$lib/context';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import SidebarDisplayFields from './SidebarDisplayFields.svelte';
	import SidebarDisplayPreview from './SidebarDisplayPreview.svelte';
	import { defaultSidebarGroupingFields } from '$lib/sidebar/display/sidebar-preferences';
	import { sidebarDisplayOptions } from '$lib/sidebar/display/sidebar-display-options';
	import { typographyScale } from '$lib/theme/typography';
	import * as m from '$lib/paraglide/messages.js';
	let { onClose, returnFocus }: { onClose: () => void; returnFocus?: () => void } = $props();
	function close(): void {
		onClose();
		void tick().then(() => returnFocus?.());
	}
	const settings = getLocalSettings();
	const remote = getRemoteSettings();
	let draft = $state({
		sidebarGroupingFields: settings.sidebarGroupingFields.map((field) => ({ ...field })),
		sidebarNestDelegatedChats: settings.sidebarNestDelegatedChats,
		sidebarInactivityDuration: settings.sidebarInactivityDuration,
		sidebarGroupNestedProjectPaths: settings.sidebarGroupNestedProjectPaths,
		sidebarChatItemLayout: settings.sidebarChatItemLayout,
		sidebarShowProjectPath: settings.sidebarShowProjectPath,
	});
	const preview = $derived(
		sidebarDisplayOptions(draft, {
			sortMode: settings.sidebarSortMode,
			pinnedInsertPosition: remote.snapshot?.ui?.pinnedInsertPosition ?? 'top',
			chatFontScale: typographyScale('chat-list', settings.chatListFontSize),
		}),
	);
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open) close();
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
						sidebarNestDelegatedChats: false,
						sidebarInactivityDuration: '3-days',
						sidebarGroupNestedProjectPaths: false,
						sidebarChatItemLayout: 'single-line',
						sidebarShowProjectPath: false,
					})}>{m.sidebar_display_reset()}</Button
			>
			<Button variant="outline" onclick={close}>{m.sidebar_actions_cancel()}</Button>
			<Button
				onclick={() => {
					settings.setSidebarDisplay(draft);
					close();
				}}>{m.sidebar_display_apply()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
