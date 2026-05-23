<script lang="ts">
	import { createEventRouter, type EventRouterStores } from '../router.svelte';
	import type { WsConnection } from '$lib/ws/connection.svelte';
	import type { DrainHandle } from '$lib/ws/drain';

	interface RouterIntegrationHostProps {
		connection: WsConnection;
		drainHandle: DrainHandle;
		stores: EventRouterStores;
	}

let { connection, drainHandle, stores }: RouterIntegrationHostProps = $props();

const routerArgs = {
	get connection() {
		return connection;
	},
	get drainHandle() {
		return drainHandle;
	},
	get stores() {
		return stores;
	},
};

createEventRouter(routerArgs.connection, routerArgs.drainHandle, routerArgs.stores);
</script>
