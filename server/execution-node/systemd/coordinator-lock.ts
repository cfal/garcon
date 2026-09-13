import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { SystemdContainmentError } from './contracts.js';

export class NodeCoordinatorLock {
  readonly #metadata: Stats;
  #released = false;

  private constructor(private readonly filePath: string, private readonly descriptor: number) {
    this.#metadata = fstatSync(descriptor);
    this.assertHeld();
  }

  static async acquire(filePath: string): Promise<NodeCoordinatorLock> {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw unavailable();
    const { dlopen, FFIType } = await import('bun:ffi');
    const library = dlopen('libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    let descriptor: number | null = null;
    try {
      // Linux O_CLOEXEC is absent from Bun's fs constants; atomic open prevents inheritance across concurrent spawn.
      // https://github.com/mkerrisk/man-pages/blob/ae6b221882ce71ba82fcdbe02419a225111502f0/man2/open.2#L217-L255
      const O_CLOEXEC = 0x80000;
      descriptor = openSync(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC, 0o600);
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw unavailable();
      const LOCK_EX = 2;
      const LOCK_NB = 4;
      if (library.symbols.flock(descriptor, LOCK_EX | LOCK_NB) !== 0) throw unavailable();
      return new NodeCoordinatorLock(filePath, descriptor);
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      throw error;
    } finally { library.close(); }
  }

  assertHeld(): void {
    if (this.#released) throw unavailable();
    const current = lstatSync(this.filePath);
    if (!current.isFile() || current.dev !== this.#metadata.dev || current.ino !== this.#metadata.ino
      || current.uid !== this.#metadata.uid || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw unavailable();
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    // Retains the inode so every future coordinator contends on the same kernel lock.
    closeSync(this.descriptor);
  }
}

function unavailable(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_UNAVAILABLE'); }
