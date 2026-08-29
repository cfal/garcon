<script lang="ts">
	import { setFileSessions, setSingletonSurfaces } from '$lib/context';
	import FilesPanel from '../FilesPanel.svelte';
	import { getFilesPanelTestContext } from './files-panel-test-context.js';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';

	let { presentation = 'window-main' }: { presentation?: WorkspaceWindowId | 'mobile' } = $props();

	const { fileSessions, singletonSurfaces } = getFilesPanelTestContext();
	setFileSessions(fileSessions);
	setSingletonSurfaces(singletonSurfaces);
</script>

<FilesPanel {presentation} />
