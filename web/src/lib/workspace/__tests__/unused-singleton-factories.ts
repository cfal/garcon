import type { SingletonSurfaceRegistryDeps } from '../singleton-surfaces.svelte';

export const unusedSingletonFactories = {
	createChatBoard() {
		throw new Error('This fixture does not open Chat Board');
	},
	createTickets() {
		throw new Error('This fixture does not open Tickets');
	},
} satisfies Pick<SingletonSurfaceRegistryDeps, 'createChatBoard' | 'createTickets'>;
