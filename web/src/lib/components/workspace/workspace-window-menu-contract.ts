import type { Snippet } from 'svelte';
import type { MenuPrimitives } from '$lib/components/ui/menu-primitives.js';

export type WorkspaceWindowSurfaceMenuItems = Snippet<[surfaceId: string, menu: MenuPrimitives]>;
