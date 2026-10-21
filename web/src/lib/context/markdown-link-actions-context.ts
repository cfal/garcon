import { createContext, type Snippet } from 'svelte';

export const [getMarkdownLinkActions, setMarkdownLinkActions, hasMarkdownLinkActions] =
	createContext<(action: Snippet) => () => void>();
