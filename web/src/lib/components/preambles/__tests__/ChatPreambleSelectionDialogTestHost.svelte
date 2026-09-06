<script lang="ts">
	import { setAppShell, setChatPreambleSelectionInvalidationHub, setPreambles } from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
	import { createChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';
	import ChatPreambleSelectionDialog from '../ChatPreambleSelectionDialog.svelte';

	const appShell = createAppShellStore();
	const preambles = new PreamblesStore();
	preambles.applySnapshot({ revision: 0, preambles: [] });
	appShell.openChatPreambleSelection('1783725900000200', 'view-a');
	setAppShell(appShell);
	setPreambles(preambles);
	setChatPreambleSelectionInvalidationHub(createChatPreambleSelectionInvalidationHub());
</script>

<ChatPreambleSelectionDialog />
