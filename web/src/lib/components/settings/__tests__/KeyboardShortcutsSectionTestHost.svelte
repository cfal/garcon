<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { setLocalSettings, setTransientLayers } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import KeyboardShortcutsSection from '../KeyboardShortcutsSection.svelte';

	interface KeyboardShortcutsSectionTestHostProps {
		transients?: TransientLayerRegistry;
	}

	let {
		transients = new TransientLayerRegistry(new ChatInteractionGate()),
	}: KeyboardShortcutsSectionTestHostProps = $props();

	const localSettings = createLocalSettingsStore();
	setLocalSettings(localSettings);
	setTransientLayers(untrack(() => transients));
	onDestroy(() => localSettings.destroy());
</script>

<KeyboardShortcutsSection />
