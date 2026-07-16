import { createContext } from 'svelte';

export interface DialogLayerControl {
	close(): void;
	focusReturnTarget(): HTMLElement | null;
}

export const [getDialogLayerControl, setDialogLayerControl] = createContext<DialogLayerControl>();
