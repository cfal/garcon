<script lang="ts">
	import { setExecutionNodesTestContext } from '$lib/execution-nodes/__tests__/execution-nodes-test-context';
	setExecutionNodesTestContext();
	import ApiProviderProtocolPanel from '../ApiProviderProtocolPanel.svelte';
	import { setModelCatalog } from '$lib/context';
	import type { ApiProtocol, ApiProviderCatalogEntry } from '$shared/api-providers';

	let {
		protocol,
		title,
		description,
		addLabel,
		apiProviderCatalog = [],
	}: {
		protocol: ApiProtocol;
		title: string;
		description: string;
		addLabel: string;
		apiProviderCatalog?: ApiProviderCatalogEntry[];
	} = $props();

	setModelCatalog({
		nodeId: 'local',
		forNode() { return this; },
		version: 0,
		get apiProviderCatalog() {
			return apiProviderCatalog;
		},
		findEndpoint(endpointId: string) {
			for (const apiProvider of apiProviderCatalog) {
				const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
				if (endpoint) return { apiProvider, endpoint };
			}
			return null;
		},
		forceRefresh() {
			return Promise.resolve();
		},
		invalidateAll() {},
	} as never);
</script>

<ApiProviderProtocolPanel {protocol} {title} {description} {addLabel} />
