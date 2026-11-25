import type { SingletonSurfaceRegistryDeps } from '../singleton-surfaces.svelte';
import { createBrowserCanvasRecovery } from '$lib/chat-canvas/canvas-recovery';

export const unusedSingletonFactories = {
	canvasRecovery: createBrowserCanvasRecovery(() => 'local'),
	createChatBoard() {
		throw new Error('This fixture does not open Chat Board');
	},
	createTickets() {
		throw new Error('This fixture does not open Tickets');
	},
} satisfies Pick<SingletonSurfaceRegistryDeps, 'canvasRecovery' | 'createChatBoard' | 'createTickets'>;
