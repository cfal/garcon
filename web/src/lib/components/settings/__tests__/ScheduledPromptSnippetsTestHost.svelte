<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		setAppShell,
		setLocalSettings,
		setPreambles,
		setSnippets,
		setTransientLayers,
	} from '$lib/context';
	import { AppShellStore } from '$lib/stores/app-shell.svelte';
	import { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte';
	import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import ScheduledPromptField from '../ScheduledPromptField.svelte';

	let { snippets, preambles }: { snippets: SnippetsStore; preambles: PreamblesStore } = $props();
	let prompt = $state('Before ');
	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	const localSettings = new LocalSettingsStore();
	setAppShell(new AppShellStore());
	setLocalSettings(localSettings);
	setSnippets(untrack(() => snippets));
	setPreambles(untrack(() => preambles));
	setTransientLayers(transientLayers);
	onDestroy(() => localSettings.destroy());
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />
<div inert={transientLayers.makesMainInert}>
	<ScheduledPromptField
		{prompt}
		promptError={null}
		targetType="new-chat"
		surface="composer"
		onPromptChange={(value) => (prompt = value)}
		onPromptKeydown={() => {}}
		snippetContext={{
			type: 'scheduled-prompt',
			target: { type: 'new-chat', projectPath: '/repo' },
		}}
	/>
</div>
<output data-testid="prompt-draft">{prompt}</output>
