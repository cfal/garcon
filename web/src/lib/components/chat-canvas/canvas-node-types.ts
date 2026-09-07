import type { Node } from '@xyflow/svelte';

export type CanvasFlowNode = Node<{ kind: 'box' | 'chat' }, 'canvasBox' | 'canvasChat'>;
