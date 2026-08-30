import { createContext } from 'svelte';

export interface DialogLayerControl {
	close(): void;
	isOpen(): boolean;
	focusReturnTarget(): HTMLElement | null;
}

export const [getDialogLayerControl, setDialogLayerControl] = createContext<DialogLayerControl>();
