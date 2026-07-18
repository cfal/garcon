<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setFileSessions, setLocalSettings } from '$lib/context';
	import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import {
		FileSessionRegistry,
		type FileOpenRequest,
	} from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import MarkdownViewer from '../MarkdownViewer.svelte';

	let {
		session,
		presentation = 'main',
		onOpen,
	}: {
		session: FileSession;
		presentation?: PresentationHostId;
		onOpen: (request: FileOpenRequest) => void;
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
		onOpen(request);
		return null;
	};

	setFileSessions(fileSessions);
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

<MarkdownViewer {session} {presentation} />
