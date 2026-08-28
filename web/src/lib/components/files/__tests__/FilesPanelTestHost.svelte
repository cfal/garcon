<script lang="ts">
	import { setFileSessions, setSingletonSurfaces } from '$lib/context';
	import FilesPanel from '../FilesPanel.svelte';
	import { getFilesPanelTestContext } from './files-panel-test-context.js';
	import type { PaneId } from '$lib/workspace/surface-types.js';

	let { presentation = 'pane-main' }: { presentation?: PaneId | 'mobile' } = $props();

	const { fileSessions, singletonSurfaces } = getFilesPanelTestContext();
	setFileSessions(fileSessions);
	setSingletonSurfaces(singletonSurfaces);
</script>

<FilesPanel {presentation} />
