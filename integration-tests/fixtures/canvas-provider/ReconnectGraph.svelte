<script lang="ts">
  import { SvelteFlow, Position, type Edge, type Node } from '@xyflow/svelte';
  import ReconnectEdge from './ReconnectEdge.svelte';
  const nodes: Node[] = ['a', 'b', 'c'].map((id, index) => ({
    id, data: { label: id }, position: { x: 50 + index * 280, y: 180 },
    sourcePosition: Position.Right, targetPosition: Position.Left,
  }));
  let edges = $state.raw<Edge[]>([{ id: 'edge', type: 'reconnect', source: 'a', target: 'b' }]);
  let starts = $state(0);
  let ends = $state(0);
  let cancellations = $state(0);
</script>

<div style="width: 1000px; height: 600px;">
  <SvelteFlow
    {nodes} bind:edges edgeTypes={{ reconnect: ReconnectEdge }}
    autoPanOnConnect={false} panOnDrag={false} zoomOnPinch={false}
    onreconnectstart={() => starts++} onreconnectend={() => ends++}
    oninteractioncancel={() => cancellations++}
  />
</div>
<output>{JSON.stringify({ edges, starts, ends, cancellations })}</output>
