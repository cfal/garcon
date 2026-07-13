import { createContext } from 'svelte';

export interface TransientLayerControl {
	close(): void;
}

export const [getTransientLayerControl, setTransientLayerControl] =
	createContext<TransientLayerControl>();
