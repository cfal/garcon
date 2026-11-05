<script lang="ts">
  import { SvelteFlow, Controls, type Node, type Edge, Position } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import type { WorkflowTaskRow } from '$lib/workflows/detail/workflow-projection.js';
  let { rows, selectedId, onselect }: { rows: readonly WorkflowTaskRow[]; selectedId: string | null; onselect: (id: string) => void } = $props();
  const graph = $derived.by(() => {
    const depth = new Map<string, number>();
    for (let pass = 0; pass < rows.length; pass++) {
      for (const { task } of rows) {
        if (!depth.has(task.id) && task.dependsOn.every(id => depth.has(id)))
          depth.set(task.id, Math.max(-1, ...task.dependsOn.map(id => depth.get(id)!)) + 1);
      }
    }
    const levels = new Map<number, number>();
    const nodes: Node[] = rows.map(({ task, phase }) => {
      const level = depth.get(task.id) ?? 0;
      const row = levels.get(level) ?? 0; levels.set(level, row + 1);
      return { id: task.id, position: { x: level * 280, y: row * 120 }, sourcePosition: Position.Right, targetPosition: Position.Left,
        data: { label: `${task.title}\n${phase.replaceAll('-', ' ')}` }, selected: selectedId === task.id,
        style: 'width:220px;min-height:72px;white-space:pre-line;background:hsl(var(--card));color:hsl(var(--foreground));border-color:hsl(var(--border));border-radius:6px;font-size:13px' };
    });
    const edges: Edge[] = rows.flatMap(({ task }) => task.dependsOn.map(id => ({ id: `${id}:${task.id}`, source: id, target: task.id,
      style: 'stroke:hsl(var(--muted-foreground))' })));
    return { nodes, edges };
  });
</script>

<div class="h-full min-h-72 w-full" data-workflow-graph>
  <SvelteFlow nodes={graph.nodes} edges={graph.edges} nodesDraggable={false} nodesConnectable={false}
    deleteKey={null} fitView minZoom={0.15} maxZoom={1.5} onnodeclick={({ node }) => onselect(node.id)}>
    <Controls showLock={false} />
  </SvelteFlow>
</div>
