<script lang="ts">
	import {
		SvelteFlow,
		Background,
		ConnectionMode,
		useSvelteFlow,
		type Edge,
		type Connection,
	} from '@xyflow/svelte';
	import { onDestroy, tick, untrack } from 'svelte';
	import '@xyflow/svelte/dist/base.css';
	import type { CanvasPosition } from '$shared/chat-canvas';
	import { isCanvasSide, CANVAS_MAX_NODES, CANVAS_MAX_CONNECTIONS } from '$shared/chat-canvas';
	import type { CanvasSession } from '$lib/chat-canvas/canvas-session.svelte';
	import type { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte';
	import { boxAt } from '$lib/chat-canvas/canvas-layout';
	import { getWorkspaceWindowDnd } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type { CanvasFlowNode } from './canvas-node-types';
	import { flowNodes, flowEdges } from './canvas-flow-model';
	import CanvasBoxNode from './CanvasBoxNode.svelte';
	import CanvasChatNode from './CanvasChatNode.svelte';

	let {
		session,
		controller,
		selectedIds,
		editing,
		visible,
		presentation,
		onselect,
		onerror,
	}: {
		session: CanvasSession;
		controller: CanvasController;
		selectedIds: ReadonlySet<string>;
		editing: boolean;
		visible: boolean;
		presentation: string;
		onselect: (ids: ReadonlySet<string>) => void;
		onerror: (message: string) => void;
	} = $props();
	const nodeTypes = { canvasBox: CanvasBoxNode, canvasChat: CanvasChatNode };
	const flow = useSvelteFlow<CanvasFlowNode>();
	const dnd = getWorkspaceWindowDnd();
	let nodes = $state.raw<CanvasFlowNode[]>([]);
	let edges = $state.raw<Edge[]>([]);
	let element: HTMLDivElement;
	let initialized = $state(false);
	let width = $state(0);
	let height = $state(0);
	let viewportApplied = false;
	let releaseInteraction: (() => void) | null = null;
	let interactionCancelled = false;

	// Adapts durable document edits to the graph engine; graph gestures remain transient until release.
	$effect(() => {
		const content = session.document.content;
		untrack(() => {
			nodes = flowNodes(content, selectedIds);
			edges = flowEdges(content, selectedIds);
		});
	});
	$effect(() => {
		const ids = selectedIds;
		untrack(() => {
			nodes = nodes.map((node) =>
				node.selected === ids.has(node.id) ? node : { ...node, selected: ids.has(node.id) },
			);
			edges = edges.map((edge) =>
				edge.selected === ids.has(edge.id) ? edge : { ...edge, selected: ids.has(edge.id) },
			);
		});
	});
	$effect(() => {
		if (
			!visible ||
			!initialized ||
			!element ||
			session.reloading ||
			controller.loading ||
			controller.closing
		)
			return;
		return untrack(() =>
			dnd.registerChatDropTarget(presentation, element, (chatId, point) => {
				if (session.document.content.nodes.length >= CANVAS_MAX_NODES) {
					onerror(m.canvas_limit());
					return;
				}
				const position = flow.screenToFlowPosition(point);
				const box = boxAt(session.document.content, position);
				session.document.addChats([chatId], box?.id ?? null, position);
			}),
		);
	});
	$effect(() => {
		if (!visible || !initialized || !width || !height || viewportApplied) return;
		const frame = requestAnimationFrame(() => {
			const viewport = controller.viewport(session.saved.id);
			viewportApplied = true;
			if (viewport) void flow.setViewport(viewport);
			else void flow.fitView({ padding: 0.2, maxZoom: 1 });
		});
		return () => cancelAnimationFrame(frame);
	});
	$effect(() => {
		if (!visible) {
			untrack(cancelInteraction);
			return;
		}
		window.addEventListener('blur', cancelInteraction);
		window.addEventListener('pointercancel', cancelInteraction);
		return () => {
			window.removeEventListener('blur', cancelInteraction);
			window.removeEventListener('pointercancel', cancelInteraction);
		};
	});
	onDestroy(endInteraction);

	function beginInteraction() {
		interactionCancelled = false;
		releaseInteraction ??= session.beginInteraction();
	}
	function endInteraction() {
		releaseInteraction?.();
		releaseInteraction = null;
	}
	function cancelInteraction() {
		if (!releaseInteraction) return;
		interactionCancelled = true;
		nodes = flowNodes(session.document.content, selectedIds);
		endInteraction();
	}

	function initialize() {
		initialized = true;
	}

	async function finishDrag(moved: CanvasFlowNode[]) {
		const release = releaseInteraction;
		const positions = new Map<string, CanvasPosition>();
		for (const node of moved) {
			const internal = flow.getInternalNode(node.id);
			if (internal) positions.set(node.id, { ...internal.internals.positionAbsolute });
		}
		try {
			if (release && editing) session.document.move(positions);
		} catch (error) {
			onerror(error instanceof Error ? error.message : String(error));
		} finally {
			await tick();
			if (releaseInteraction === release) {
				nodes = flowNodes(session.document.content, selectedIds);
				endInteraction();
				interactionCancelled = false;
			}
		}
	}

	// Only document-owned connections are projected; Svelte Flow must not insert rejected edges.
	function connect(connection: Connection) {
		if (!visible || !editing || interactionCancelled || connection.source === connection.target)
			return;
		if (session.document.content.connections.length >= CANVAS_MAX_CONNECTIONS) {
			onerror(m.canvas_limit());
			return;
		}
		session.document.connect({
			source: connection.source,
			target: connection.target,
			label: '',
			sourceSide: isCanvasSide(connection.sourceHandle) ? connection.sourceHandle : 'right',
			targetSide: isCanvasSide(connection.targetHandle) ? connection.targetHandle : 'left',
		});
	}

	export function centerPosition(): CanvasPosition {
		if (!element) return { x: 0, y: 0 };
		const rect = element.getBoundingClientRect();
		return flow.screenToFlowPosition({
			x: rect.left + rect.width / 2 - 150,
			y: rect.top + rect.height / 2 - 80,
		});
	}
	export function fit(): void {
		void flow.fitView({ padding: 0.2, maxZoom: 1 });
	}
	export function zoomIn(): void {
		void flow.setZoom(flow.getZoom() * 1.2);
	}
	export function zoomOut(): void {
		void flow.setZoom(flow.getZoom() / 1.2);
	}
	export function focusNode(id: string): void {
		void flow.fitView({ nodes: [{ id }], padding: 0.5, minZoom: 0.5, maxZoom: 1 });
	}
</script>

<div
	class="canvas-flow h-full w-full"
	bind:this={element}
	bind:clientWidth={width}
	bind:clientHeight={height}
	data-canvas-flow
>
	<SvelteFlow
		bind:nodes
		bind:edges
		{nodeTypes}
		id={`canvas-${session.saved.id}`}
		connectionMode={ConnectionMode.Loose}
		nodesDraggable={editing}
		nodesConnectable={editing}
		deleteKey={null}
		disableKeyboardA11y
		minZoom={0.15}
		maxZoom={2}
		zoomOnDoubleClick={false}
		panOnScroll
		panOnDrag
		selectionOnDrag={editing}
		oninit={initialize}
		onbeforeconnect={connect}
		onconnectstart={beginInteraction}
		onconnectend={() => {
			endInteraction();
			interactionCancelled = false;
		}}
		onclickconnectstart={() => {
			interactionCancelled = false;
		}}
		isValidConnection={(edge) => edge.source !== edge.target}
		onnodedragstop={({ nodes: moved }) => finishDrag(moved)}
		onnodedragstart={beginInteraction}
		onselectiondragstart={beginInteraction}
		onselectionchange={({ nodes: selectedNodes, edges: selectedEdges }) =>
			untrack(() => {
				const next = new Set([
					...selectedNodes.map((node) => node.id),
					...selectedEdges.map((edge) => edge.id),
				]);
				if (next.size !== selectedIds.size || [...next].some((id) => !selectedIds.has(id)))
					onselect(next);
			})}
		onmoveend={(_event, viewport) => {
			if (viewportApplied) controller.setViewport(session.saved.id, viewport);
		}}
	>
		<Background patternColor="hsl(var(--border))" gap={24} />
	</SvelteFlow>
</div>
