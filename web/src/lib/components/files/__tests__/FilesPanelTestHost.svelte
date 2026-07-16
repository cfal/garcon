<script lang="ts">
	import { setFileSessions, setSingletonSurfaces } from '$lib/context';
	import FilesPanel from '../FilesPanel.svelte';
	import { getFilesPanelTestContext } from './files-panel-test-context.js';

	const { fileSessions, singletonSurfaces } = getFilesPanelTestContext();
	setFileSessions(fileSessions);
	setSingletonSurfaces(singletonSurfaces);
</script>

<FilesPanel />
