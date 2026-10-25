import { createContext, type Snippet } from 'svelte';

export const [getMarkdownLinkActions, setMarkdownLinkActions, hasMarkdownLinkActions] =
	createContext<(element: HTMLElement, action: Snippet) => () => void>();
