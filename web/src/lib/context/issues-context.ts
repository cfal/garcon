import { createContext } from 'svelte';
import type { IssuesInvalidationHub } from '$lib/issues/catalog/issues-invalidation-hub.js';

export const [getIssuesInvalidations, setIssuesInvalidations] = createContext<IssuesInvalidationHub>();
