<script lang="ts">
	import ChatProjectPathDialog from '$lib/components/chat/ChatProjectPathDialog.svelte';
	import type { ChatActionController } from '$lib/components/chat/chat-action-controller.svelte';
	import type { ChatActionDialogsState } from '$lib/components/chat/chat-action-dialogs-state.svelte';
	import { getAppShell, getRemoteSettings } from '$lib/context';
	import {
		executorPinnedProjectPaths,
		togglePinnedProjectPathOptimistically,
	} from '$lib/project-paths/pinned-project-path-settings.js';

	let { dialogs, controller, isMobile }: {
		dialogs: ChatActionDialogsState;
		controller: ChatActionController;
		isMobile: boolean;
	} = $props();
	const appShell = getAppShell();
	const remoteSettings = getRemoteSettings();
</script>

<ChatProjectPathDialog
	projectPathDialog={dialogs.chatProjectPathDialog}
	projectBasePath={appShell.projectBasePath}
	pinnedProjectPaths={executorPinnedProjectPaths(remoteSettings.snapshot, dialogs.chatProjectPathDialog?.executorId ?? 'local')}
	onTogglePinnedProjectPath={async (path) => {
		await togglePinnedProjectPathOptimistically(remoteSettings, path, {
			executorId: dialogs.chatProjectPathDialog?.executorId ?? 'local',
		});
	}}
	{isMobile}
	onClose={() => dialogs.closeProjectPathDialog()}
	onConfirm={(target, projectPath) => controller.updateProjectPath(target, projectPath)}
/>
