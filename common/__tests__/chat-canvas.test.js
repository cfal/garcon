import { describe, expect, it } from 'bun:test';
import { parseCanvasContent, parseChatCanvas, parseCanvasList } from '../chat-canvas.ts';

const content = () => ({ title: 'Work', nodes: [
  { id: 'box', type: 'box', title: 'Research', position: { x: -20, y: 30 } },
  { id: 'chat', type: 'chat', chatId: '1780000000000001', boxId: 'box', position: { x: 0, y: 0 } },
], connections: [{ id: 'connection', source: 'box', target: 'chat', sourceSide: 'right', targetSide: 'left', label: 'contains' }] });

describe('canvas contracts', () => {
  it('reports unavailable identities and rejects malformed or overlapping catalog entries', () => {
    expect(parseCanvasList({ canvases: [], unavailableIds: ['damaged'] })).toEqual({
      canvases: [], unavailableIds: ['damaged'],
    });
    for (const unavailableIds of [undefined, ['../outside'], ['duplicate', 'duplicate'], Array(101).fill('a')]) {
      expect(() => parseCanvasList({ canvases: [], unavailableIds })).toThrow();
    }
    expect(() => parseCanvasList({
      canvases: [{ id: 'a', title: 'Work', revision: 1, updatedAt: '2026-09-07T00:00:00Z' }],
      unavailableIds: ['a'],
    })).toThrow();
  });

  it('round-trips references, order, coordinates, labels, and document revisions', () => {
    const document = { version: 1, id: 'canvas-a', revision: 3, updatedAt: '2026-09-07T00:00:00.000Z', content: content() };
    expect(parseChatCanvas(JSON.parse(JSON.stringify(document)))).toEqual(document);
    expect(parseCanvasList({ unavailableIds: [], canvases: [{ id: document.id, title: 'Work', revision: 3, updatedAt: document.updatedAt }] }).canvases).toHaveLength(1);
  });

  it('rejects dangling membership, duplicate identities, malformed positions, and unknown node types', () => {
    const invalid = [
      (c) => { c.nodes[1].boxId = 'missing'; },
      (c) => { c.nodes[1].boxId = 'chat'; },
      (c) => { c.nodes[1].id = 'box'; },
      (c) => { c.nodes[0].position.x = Infinity; },
      (c) => { c.nodes[0].position.y = 1e10; },
      (c) => { c.nodes[0].type = 'circle'; },
      (c) => { c.nodes[1].chatId = '../chat'; },
      (c) => { c.connections[0].target = 'unknown'; },
      (c) => { c.connections[0].target = 'box'; },
      (c) => { c.connections.push(c.connections[0]); },
      (c) => { c.title = ' '; },
      (c) => { c.connections[0].sourceSide = 'center'; },
    ];
    for (const mutate of invalid) {
      const candidate = content(); mutate(candidate);
      expect(() => parseCanvasContent(candidate)).toThrow();
    }
  });

  it('strips runtime chat data and permits several references to the same chat', () => {
    const candidate = content();
    candidate.nodes[1].transcript = 'SYNTHETIC_UNPERSISTED_CONTENT';
    candidate.nodes.push({ ...candidate.nodes[1], id: 'second-placement', boxId: null });
    const parsed = parseCanvasContent(candidate);
    expect(parsed.nodes).toHaveLength(3);
    expect(JSON.stringify(parsed)).not.toContain('transcript');
  });
});
