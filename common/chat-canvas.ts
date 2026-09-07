import { isRecord } from './json.js';
import { parseChatId } from './chat-id.js';

export const CANVAS_MAX_NODES = 1_000;
export const CANVAS_MAX_CONNECTIONS = 2_000;
export const CANVAS_MAX_COUNT = 100;
export const CANVAS_TITLE_MAX_LENGTH = 120;
export const CANVAS_LABEL_MAX_LENGTH = 300;

export interface CanvasPosition { x: number; y: number }

export interface CanvasBox {
  id: string;
  type: 'box';
  title: string;
  position: CanvasPosition;
}

export interface CanvasChat {
  id: string;
  type: 'chat';
  chatId: string;
  boxId: string | null;
  position: CanvasPosition;
}

export type CanvasNode = CanvasBox | CanvasChat;
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

export interface CanvasConnection {
  id: string;
  source: string;
  target: string;
  sourceSide: CanvasSide;
  targetSide: CanvasSide;
  label: string;
}

// Node order determines the order of chats within each box.
export interface CanvasContent {
  title: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}

export interface ChatCanvas {
  version: 1;
  id: string;
  revision: number;
  updatedAt: string;
  content: CanvasContent;
}

export interface CanvasSummary {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
}

export interface CanvasListResponse { canvases: CanvasSummary[] }
export interface CreateCanvasRequest { id: string; content: CanvasContent }
export interface UpdateCanvasRequest extends CreateCanvasRequest { expectedRevision: number }
export interface DeleteCanvasRequest { id: string; expectedRevision: number }
export interface DeleteCanvasResponse { success: true }

export function isCanvasId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export function isCanvasRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function text(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
}

function position(value: unknown): value is CanvasPosition {
  return isRecord(value) && [value.x, value.y].every(
    (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= 10_000_000,
  );
}

export function isCanvasSide(value: unknown): value is CanvasSide {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

export function parseCanvasContent(value: unknown): CanvasContent {
  if (!isRecord(value) || !text(value.title, CANVAS_TITLE_MAX_LENGTH, true)
    || !Array.isArray(value.nodes) || value.nodes.length > CANVAS_MAX_NODES
    || !Array.isArray(value.connections) || value.connections.length > CANVAS_MAX_CONNECTIONS) {
    throw new Error('Invalid canvas title or element count');
  }
  const ids = new Set<string>();
  const nodes: CanvasNode[] = value.nodes.map((node: unknown) => {
    if (!isRecord(node) || !isCanvasId(node.id) || ids.has(node.id) || !position(node.position)) {
      throw new Error('Invalid or duplicate canvas node');
    }
    ids.add(node.id);
    const base = { id: node.id, position: { x: node.position.x, y: node.position.y } };
    if (node.type === 'box' && text(node.title, CANVAS_TITLE_MAX_LENGTH, true)) {
      return { ...base, type: 'box', title: node.title };
    }
    if (node.type === 'chat' && (node.boxId === null || isCanvasId(node.boxId))) {
      return { ...base, type: 'chat', chatId: parseChatId(node.chatId), boxId: node.boxId };
    }
    throw new Error('Invalid canvas node content');
  });
  const boxes = new Set(nodes.filter((node) => node.type === 'box').map((node) => node.id));
  if (nodes.some((node) => node.type === 'chat' && node.boxId !== null && !boxes.has(node.boxId))) {
    throw new Error('Canvas chat references an unknown box');
  }
  const connectionIds = new Set<string>();
  const connections = value.connections.map((edge: unknown): CanvasConnection => {
    if (!isRecord(edge) || !isCanvasId(edge.id) || connectionIds.has(edge.id) || ids.has(edge.id)
      || typeof edge.source !== 'string' || !ids.has(edge.source)
      || typeof edge.target !== 'string' || !ids.has(edge.target) || edge.source === edge.target
      || !isCanvasSide(edge.sourceSide) || !isCanvasSide(edge.targetSide)
      || !text(edge.label, CANVAS_LABEL_MAX_LENGTH)) {
      throw new Error('Invalid canvas connection');
    }
    connectionIds.add(edge.id);
    return { id: edge.id, source: edge.source, target: edge.target, sourceSide: edge.sourceSide,
      targetSide: edge.targetSide, label: edge.label };
  });
  return { title: value.title, nodes, connections };
}

export function parseChatCanvas(value: unknown): ChatCanvas {
  if (!isRecord(value) || value.version !== 1 || !isCanvasId(value.id)
    || !isCanvasRevision(value.revision) || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid canvas document');
  return { version: 1, id: value.id, revision: value.revision, updatedAt: value.updatedAt,
    content: parseCanvasContent(value.content) };
}

export function canvasSummary(canvas: ChatCanvas): CanvasSummary {
  return { id: canvas.id, title: canvas.content.title, revision: canvas.revision, updatedAt: canvas.updatedAt };
}

export function parseCanvasList(value: unknown): CanvasListResponse {
  if (!isRecord(value) || !Array.isArray(value.canvases) || value.canvases.length > CANVAS_MAX_COUNT) {
    throw new Error('Invalid canvas list');
  }
  const ids = new Set<string>();
  const canvases = value.canvases.map((entry: unknown): CanvasSummary => {
    if (!isRecord(entry) || !isCanvasId(entry.id) || ids.has(entry.id)
      || !text(entry.title, CANVAS_TITLE_MAX_LENGTH, true) || !isCanvasRevision(entry.revision)
      || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) {
      throw new Error('Invalid canvas summary');
    }
    ids.add(entry.id);
    return { id: entry.id, title: entry.title, revision: entry.revision, updatedAt: entry.updatedAt };
  });
  return { canvases };
}
