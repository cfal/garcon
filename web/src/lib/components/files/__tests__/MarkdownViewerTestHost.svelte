<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		setFileSessions,
		setLocalSettings,
		setNotifications,
		setWorkspaceLayout,
	} from '$lib/context';
	import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import {
		FileSessionRegistry,
		type FileOpenRequest,
	} from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import {
		createNotificationsStore,
		type NotificationsStore,
	} from '$lib/stores/notifications.svelte.js';
	import type { PresentationHostId, WorkspaceLayoutReader } from '$lib/workspace/surface-types.js';
	import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
	import MarkdownViewer from '../MarkdownViewer.svelte';

	let {
		session,
		presentation = 'main',
		onOpen,
		notifications = createNotificationsStore(),
		workspaceLayout = createWorkspaceLayoutStore(),
	}: {
		session: FileSession;
		presentation?: PresentationHostId;
		onOpen: (request: FileOpenRequest) => void | FileSession | null | Promise<FileSession | null>;
		notifications?: NotificationsStore;
		workspaceLayout?: WorkspaceLayoutReader;
	} = $props();

	const localSettings = createLocalSettingsStore();
	localSettings.markdownViewerFontSize = '14';
	const fileSessions = new FileSessionRegistry({
		getIsMobile: () => presentation === 'mobile',
		getDefaultPlacement: () => 'dialog',
		getEditorSettings: () => ({
			wordWrap: false,
			showLineNumbers: true,
			fontSize: 12,
		}),
		getPlacement: () => ({
			async placeFileSession(_sessionId, _target, publication) {
				publication.publish();
				return 'placed';
			},
			async focusFileSession() {},
		}),
		resolveFileIdentity: async ({ relativePath }) => ({
			success: true,
			identity: {
				canonicalFileRootPath: session.canonicalFileRootPath,
				normalizedRelativePath: relativePath,
			},
		}),
	});
	fileSessions.open = async (request) => {
		return (await onOpen(request)) ?? null;
	};

	setFileSessions(fileSessions);
	setLocalSettings(localSettings);
	setNotifications(untrack(() => notifications));
	setWorkspaceLayout(untrack(() => workspaceLayout));
	onDestroy(() => localSettings.destroy());
</script>

<MarkdownViewer {session} {presentation} />
