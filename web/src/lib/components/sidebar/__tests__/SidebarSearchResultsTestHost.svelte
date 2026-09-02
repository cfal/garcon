<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import { setModelCatalog } from '$lib/context';
	import SidebarSearchResults from '../SidebarSearchResults.svelte';

	let props: ComponentProps<typeof SidebarSearchResults> = $props();

	class TestModelCatalogStore extends ModelCatalogStore {
		override getAgentLabel(agentId: string): string {
			return agentId === 'claude' ? 'Claude' : agentId;
		}
	}

	setModelCatalog(new TestModelCatalogStore());
</script>

<SidebarSearchResults {...props} />
