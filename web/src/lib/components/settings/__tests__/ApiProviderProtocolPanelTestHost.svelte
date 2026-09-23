<script lang="ts">
	import { setExecutionNodesTestContext } from '$lib/execution-nodes/__tests__/execution-nodes-test-context';
	setExecutionNodesTestContext();
	import ApiProviderProtocolPanel from '../ApiProviderProtocolPanel.svelte';
	import { setModelCatalog, setApiProviders } from '$lib/context';
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte';
	import { untrack } from 'svelte';
	import type { ApiProtocol, ApiProviderCatalogEntry } from '$shared/api-providers';

	let {
		protocol,
		title,
		description,
		addLabel,
		apiProviderCatalog = [],
		unassign,
	}: {
		protocol: ApiProtocol;
		title: string;
		description: string;
		addLabel: string;
		apiProviderCatalog?: ApiProviderCatalogEntry[];
		unassign?: NonNullable<ConstructorParameters<typeof ApiProvidersStore>[1]>['unassign'];
	} = $props();

	const catalog = new ModelCatalogStore();
	setModelCatalog(catalog);
	const snapshot = () => ({
		providers: apiProviderCatalog,
		assignments: {
			revision: 0,
			assignments: { local: apiProviderCatalog.map((profile) => profile.id) },
		},
	});
	const providers = new ApiProvidersStore(() => catalog.invalidateAll(), {
		read: async () => snapshot(),
		assign: async () => snapshot(),
		unassign: untrack(() => unassign) ?? (async () => snapshot()),
		delete: async () => ({ success: true }),
	});
	providers.snapshot = untrack(snapshot);
	setApiProviders(providers);
</script>

<ApiProviderProtocolPanel {protocol} {title} {description} {addLabel} />
