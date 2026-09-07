import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CANVAS_MAX_COUNT, canvasSummary, isCanvasId, parseChatCanvas,
  type CanvasContent, type CanvasListResponse, type ChatCanvas,
} from '../../common/chat-canvas.js';
import { writeJsonFileAtomic, syncDirectory } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { hasNodeErrorCode } from '../lib/errors.js';

export class CanvasError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'CanvasError';
  }
}

export class CanvasStore {
  readonly #directory: string;
  readonly #lock = new KeyedPromiseLock();

  constructor(workspaceDir: string) {
    this.#directory = path.join(workspaceDir, 'chat-canvases');
  }

  async list(): Promise<CanvasListResponse> {
    let files: string[];
    try { files = await fs.readdir(this.#directory); }
    catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) return { canvases: [], unavailableIds: [] };
      throw error;
    }
    const canvases = [];
    const unavailableIds: string[] = [];
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      const id = file.slice(0, -5);
      if (!isCanvasId(id)) continue;
      try { canvases.push(canvasSummary(await this.get(id))); }
      catch (error) {
        if (error instanceof CanvasError && error.status === 404) continue;
        if (error instanceof CanvasError && error.code === 'CANVAS_CORRUPT') {
          unavailableIds.push(id);
          continue;
        }
        throw error;
      }
    }
    return { canvases: canvases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
      unavailableIds: unavailableIds.sort() };
  }

  async get(id: string): Promise<ChatCanvas> {
    const filePath = this.#path(id);
    let raw: string;
    try { raw = await fs.readFile(filePath, 'utf8'); }
    catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) throw new CanvasError('CANVAS_NOT_FOUND', 'Canvas not found', 404);
      throw error;
    }
    try {
      const canvas = parseChatCanvas(JSON.parse(raw));
      if (canvas.id !== id) throw new Error('Canvas ID does not match its file');
      return canvas;
    } catch {
      throw new CanvasError('CANVAS_CORRUPT', 'Canvas data could not be read. Restore it from a backup.', 500);
    }
  }

  async create(id: string, content: CanvasContent): Promise<ChatCanvas> {
    this.#path(id);
    return this.#lock.runExclusive('catalog', () => this.#lock.runExclusive(`canvas:${id}`, async () => {
      try {
        const existing = await this.get(id);
        if (JSON.stringify(existing.content) === JSON.stringify(content)) return existing;
        throw new CanvasError('CANVAS_EXISTS', 'A canvas with this ID already exists', 409);
      } catch (error) {
        if (!(error instanceof CanvasError && error.status === 404)) throw error;
      }
      const catalog = await this.list();
      if (catalog.canvases.length + catalog.unavailableIds.length >= CANVAS_MAX_COUNT) {
        throw new CanvasError('CANVAS_LIMIT', `A maximum of ${CANVAS_MAX_COUNT} canvases is allowed`, 409);
      }
      const canvas: ChatCanvas = { version: 1, id, revision: 1, updatedAt: new Date().toISOString(), content };
      await writeJsonFileAtomic(this.#path(id), canvas, { mode: 0o600 });
      return canvas;
    }));
  }

  async update(id: string, expectedRevision: number, content: CanvasContent): Promise<ChatCanvas> {
    return this.#lock.runExclusive(`canvas:${id}`, async () => {
      const current = await this.get(id);
      // An identical retry reconciles a response lost after the atomic write.
      if (JSON.stringify(current.content) === JSON.stringify(content)) return current;
      this.#assertRevision(current, expectedRevision);
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new CanvasError('CANVAS_REVISION_EXHAUSTED', 'Canvas revision limit reached', 409);
      }
      const canvas: ChatCanvas = { ...current, revision: current.revision + 1,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(), content };
      await writeJsonFileAtomic(this.#path(id), canvas, { mode: 0o600 });
      return canvas;
    });
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    await this.#lock.runExclusive(`canvas:${id}`, async () => {
      this.#assertRevision(await this.get(id), expectedRevision);
      await fs.unlink(this.#path(id));
      await syncDirectory(this.#directory);
    });
  }

  #path(id: string): string {
    if (!isCanvasId(id)) throw new CanvasError('CANVAS_INVALID', 'Invalid canvas ID', 400);
    return path.join(this.#directory, `${id}.json`);
  }

  #assertRevision(canvas: ChatCanvas, expected: number): void {
    if (canvas.revision !== expected) {
      throw new CanvasError('CANVAS_CONFLICT', 'This canvas changed in another client. Load the latest version or save your work as a copy.', 409);
    }
  }
}
