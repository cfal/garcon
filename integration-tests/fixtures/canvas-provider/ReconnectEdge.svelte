<script lang="ts">
  import { BaseEdge, EdgeReconnectAnchor, getBezierPath, type EdgeProps } from '@xyflow/svelte';
  let props: EdgeProps = $props();
  const path = $derived(getBezierPath(props)[0]);
</script>

<BaseEdge id={props.id} {path} />
<EdgeReconnectAnchor type="target" position={{ x: props.targetX, y: props.targetY }} />
