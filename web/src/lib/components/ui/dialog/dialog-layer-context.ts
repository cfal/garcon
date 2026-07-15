import { createContext } from 'svelte';

export interface DialogLayerControl {
	close(): void;
}

export const [getDialogLayerControl, setDialogLayerControl] = createContext<DialogLayerControl>();
