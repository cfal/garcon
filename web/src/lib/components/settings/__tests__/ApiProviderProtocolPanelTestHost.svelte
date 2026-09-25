<script lang="ts">
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import ApiProviderProtocolPanel from '../ApiProviderProtocolPanel.svelte';
	import { setModelCatalog, setApiProviders } from '$lib/context';
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte';
	import { untrack } from 'svelte';
	import type { ApiProtocol, ApiProviderCatalogEntry } from '$shared/api-providers';
	import type { ExecutorSnapshot } from '$shared/executors';

	let {
		protocol,
		title,
		description,
		addLabel,
		apiProviderCatalog = [],
		unassign,
		executors,
		assignments,
	}: {
		protocol: ApiProtocol;
		title: string;
		description: string;
		addLabel: string;
		apiProviderCatalog?: ApiProviderCatalogEntry[];
		unassign?: NonNullable<ConstructorParameters<typeof ApiProvidersStore>[1]>['unassign'];
		executors?: readonly ExecutorSnapshot[];
		assignments?: Record<string, string[]>;
	} = $props();
	setExecutorsTestContext(untrack(() => executors));

	const catalog = new ModelCatalogStore();
	setModelCatalog(catalog);
	const snapshot = () => ({
		providers: apiProviderCatalog,
		assignments: {
			revision: 0,
			assignments: assignments ?? { local: apiProviderCatalog.map((profile) => profile.id) },
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
