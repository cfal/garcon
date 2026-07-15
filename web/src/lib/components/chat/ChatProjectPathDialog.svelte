<script lang="ts">
	import SidebarProjectPathDialog from '$lib/components/sidebar/SidebarProjectPathDialog.svelte';
	import type { ChatProjectPathDialog } from './chat-action-dialogs-state.svelte';
	import { getRemoteSettings } from '$lib/context';
	import { togglePinnedProjectPathOptimistically } from '$lib/chat/project-paths/pinned-project-path-settings.js';

	interface ChatProjectPathDialogProps {
		projectPathDialog: ChatProjectPathDialog | null;
		projectBasePath: string;
		isMobile: boolean;
		onClose: () => void;
		onConfirm: (chatId: string, projectPath: string) => Promise<void> | void;
	}

	let {
		projectPathDialog,
		projectBasePath,
		isMobile,
		onClose,
		onConfirm,
	}: ChatProjectPathDialogProps = $props();

	const remoteSettings = getRemoteSettings();
	const pinnedProjectPaths = $derived(remoteSettings.snapshot?.paths.pinnedProjectPaths ?? []);

	async function togglePinnedProjectPath(path: string): Promise<void> {
		await togglePinnedProjectPathOptimistically(remoteSettings, path);
	}
</script>

<SidebarProjectPathDialog
	{projectPathDialog}
	{projectBasePath}
	{pinnedProjectPaths}
	{isMobile}
	{onClose}
	{onConfirm}
	onTogglePinnedProjectPath={togglePinnedProjectPath}
/>
