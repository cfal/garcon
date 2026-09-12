import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseSystemdHelperRequest, parseSystemdIdentity, SystemdContainmentError, type SystemdLaunchIdentity, type SystemdUnitIdentity } from './contracts.js';
import { systemdExecutionUnitName } from './launch.js';

const MAX_MARKER_BYTES = 16_384;

export interface NodeSessionHostMarker {
  readonly version: 1;
  readonly controllerId: string;
  readonly nodeId: string;
  readonly launch: SystemdLaunchIdentity;
  readonly identity: SystemdUnitIdentity | null;
}

export interface NodeSessionMarkerStore {
  read(): Promise<NodeSessionHostMarker | null>;
  recordLaunch(launch: SystemdLaunchIdentity): Promise<void>;
  recordIdentity(identity: SystemdUnitIdentity): Promise<void>;
  clear(expected: SystemdLaunchIdentity): Promise<void>;
}

export interface NodeSessionMarkerOptions {
  readonly runtimeDirectory: string;
  readonly controllerId: string;
  readonly nodeId: string;
  onCompromised(): void;
}

export function parseNodeSessionHostMarker(value: unknown): NodeSessionHostMarker | null {
  if (!fields(value, ['version', 'controllerId', 'nodeId', 'launch', 'identity']) || value.version !== 1
    || !isExecutionIdentity(value.controllerId) || !isExecutionIdentity(value.nodeId)
    || !fields(value.launch, ['unitName', 'launchId'])) return null;
  const request = parseSystemdHelperRequest({ kind: 'inspect', launch: value.launch });
  if (!request || request.kind !== 'inspect' || request.launch.unitName !== systemdExecutionUnitName(value.nodeId)) return null;
  const identity = value.identity === null ? null
    : fields(value.identity, ['unitName', 'launchId', 'invocationId', 'controlGroup', 'mainPid']) ? parseSystemdIdentity(value.identity) : null;
  if (value.identity !== null && (!identity || !sameLaunch(identity, request.launch))) return null;
  return { version: 1, controllerId: value.controllerId, nodeId: value.nodeId, launch: request.launch, identity };
}

/** Stores cleanup evidence under an exclusive node namespace; it never restores execution authority. */
export class NodeSessionMarkerFile implements NodeSessionMarkerStore {
  readonly filePath: string;
  readonly #directory: string;
  #compromised = false;
  #released = false;
  #releasing: Promise<void> | null = null;
  #pending: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: NodeSessionMarkerOptions, directory: string, private readonly releaseLock: () => Promise<void>) {
    this.#directory = directory;
    this.filePath = path.join(directory, 'session-host.json');
  }

  static async acquire(options: NodeSessionMarkerOptions): Promise<NodeSessionMarkerFile> {
    if (!isExecutionIdentity(options.nodeId) || !isExecutionIdentity(options.controllerId)) throw invalid();
    const runtimeDirectory = path.resolve(options.runtimeDirectory);
    if (await realpath(runtimeDirectory) !== runtimeDirectory) throw invalid();
    await privateDirectory(runtimeDirectory);
    const parent = path.join(runtimeDirectory, 'garcon-execution');
    await mkdir(parent, { mode: 0o700 }).catch(alreadyExists);
    await privateDirectory(parent);
    const directory = path.join(parent, createHash('sha256').update(options.nodeId).digest('hex'));
    await mkdir(directory, { mode: 0o700 }).catch(alreadyExists);
    await privateDirectory(directory);
    let owner: NodeSessionMarkerFile | null = null;
    let compromised = false;
    const release = await lockfile.lock(directory, { realpath: false, lockfilePath: path.join(directory, '.coordinator.lock'),
      stale: 30_000, update: 5_000, retries: 0,
      onCompromised() {
        compromised = true;
        if (owner) owner.#compromised = true;
        options.onCompromised();
      },
    });
    owner = new NodeSessionMarkerFile(options, directory, release);
    owner.#compromised = compromised;
    return owner;
  }

  read(): Promise<NodeSessionHostMarker | null> { return this.#serialize(() => this.#read()); }

  recordLaunch(value: SystemdLaunchIdentity): Promise<void> {
    const request = parseSystemdHelperRequest({ kind: 'inspect', launch: value });
    if (!request || request.kind !== 'inspect' || request.launch.unitName !== systemdExecutionUnitName(this.options.nodeId)) return Promise.reject(invalid());
    const marker: NodeSessionHostMarker = { version: 1, controllerId: this.options.controllerId, nodeId: this.options.nodeId,
      launch: request.launch, identity: null };
    return this.#serialize(async () => {
      if (await this.#read()) throw invalid();
      await this.#write(marker);
    });
  }

  recordIdentity(value: SystemdUnitIdentity): Promise<void> {
    const identity = parseSystemdIdentity(value);
    if (!identity) return Promise.reject(invalid());
    return this.#serialize(async () => {
      const current = await this.#read();
      if (!current || !sameLaunch(current.launch, identity)
        || current.identity && !sameIdentity(current.identity, identity)) throw invalid();
      await this.#write({ ...current, identity });
    });
  }

  /** Called only after the exact launch has been proven stopped by the containment owner. */
  clear(expected: SystemdLaunchIdentity): Promise<void> {
    const request = parseSystemdHelperRequest({ kind: 'inspect', launch: { unitName: expected.unitName, launchId: expected.launchId } });
    if (!request || request.kind !== 'inspect') return Promise.reject(invalid());
    return this.#serialize(async () => {
      const current = await this.#read();
      if (!current) return;
      if (!sameLaunch(current.launch, request.launch)) throw invalid();
      this.#assertOwned();
      await unlink(this.filePath);
      await this.#syncDirectory();
    });
  }

  release(): Promise<void> {
    this.#releasing ??= this.#pending.then(async () => { this.#released = true; await this.releaseLock(); });
    return this.#releasing;
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    if (this.#releasing) return Promise.reject(invalid());
    const result = this.#pending.then(() => { this.#assertOwned(); return action(); });
    this.#pending = result.catch(() => {});
    return result;
  }

  async #read(): Promise<NodeSessionHostMarker | null> {
    this.#assertOwned();
    await privateDirectory(this.#directory);
    const handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw invalid();
    });
    if (!handle) return null;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.uid !== process.geteuid?.() || (stats.mode & 0o077) !== 0 || stats.nlink !== 1
        || stats.size > MAX_MARKER_BYTES) throw invalid();
      const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > MAX_MARKER_BYTES) throw invalid();
      const marker = parseNodeSessionHostMarker(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))));
      if (!marker || marker.nodeId !== this.options.nodeId || marker.controllerId !== this.options.controllerId) throw invalid();
      this.#assertOwned();
      return marker;
    } catch { throw invalid(); }
    finally { await handle.close(); }
  }

  async #write(marker: NodeSessionHostMarker): Promise<void> {
    const temporary = path.join(this.#directory, `.session-host-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      this.#assertOwned();
      await rename(temporary, this.filePath);
      await this.#syncDirectory();
      this.#assertOwned();
    } finally {
      await handle.close();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  #assertOwned(): void { if (this.#released || this.#compromised) throw invalid(); }
}

async function privateDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.geteuid?.() || (stats.mode & 0o077) !== 0) throw invalid();
}

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sameLaunch(a: SystemdLaunchIdentity, b: SystemdLaunchIdentity): boolean { return a.unitName === b.unitName && a.launchId === b.launchId; }
function sameIdentity(a: SystemdUnitIdentity, b: SystemdUnitIdentity): boolean {
  return sameLaunch(a, b) && a.invocationId === b.invocationId && a.controlGroup === b.controlGroup && a.mainPid === b.mainPid;
}
function alreadyExists(error: NodeJS.ErrnoException): void { if (error.code !== 'EEXIST') throw error; }
function invalid(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_MISMATCH'); }
