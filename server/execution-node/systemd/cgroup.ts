import * as fs from 'node:fs';
import { isControlGroup, SystemdContainmentError } from './contracts.js';

const MOUNT_POINT = '/sys/fs/cgroup';
const CGROUP2_SUPER_MAGIC = 0x63677270;

export interface CgroupObservation {
  isEmpty(): boolean;
}

export interface CgroupReader {
  observe(controlGroup: string, managerControlGroup: string): CgroupObservation;
}

export type CgroupFileSystem = Pick<typeof fs,
  'statfsSync' | 'realpathSync' | 'lstatSync' | 'openSync' | 'readSync' | 'closeSync'>;

export function cgroupFilesystemPath(controlGroup: string, managerControlGroup: string): string {
  if (!isControlGroup(controlGroup) || !isControlGroup(managerControlGroup)
    || !controlGroup.startsWith(`${managerControlGroup}/`)) {
    throw new SystemdContainmentError('NODE_CONTAINMENT_MISMATCH');
  }
  return `${MOUNT_POINT}${controlGroup}`;
}

export function parseCgroupEvents(content: string): boolean {
  const lines = content.replace(/\n$/, '').split('\n');
  if (lines.some((line) => !/^[a-z_]+ [0-9]+$/.test(line))) throw invalid();
  const populated = lines.filter((line) => line.startsWith('populated '));
  if (populated.length !== 1 || !/^populated [01]$/.test(populated[0]!)) throw invalid();
  return populated[0] === 'populated 0';
}

export class NativeCgroupReader implements CgroupReader {
  constructor(private readonly files: CgroupFileSystem = fs) {}

  observe(controlGroup: string, managerControlGroup: string): CgroupObservation {
    const path = cgroupFilesystemPath(controlGroup, managerControlGroup);
    this.#verifyMount();
    return { isEmpty: () => {
      this.#verifyMount();
      let descriptor: number;
      try {
        descriptor = this.files.openSync(`${path}/cgroup.events`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch (error) {
        if (!missing(error)) throw error;
        try { this.files.lstatSync(path); } catch (directoryError) {
          if (missing(directoryError)) return true;
          throw directoryError;
        }
        throw invalid();
      }
      try {
        const bytes = Buffer.alloc(4_096);
        const length = this.files.readSync(descriptor, bytes, 0, bytes.length, 0);
        if (length === bytes.length) throw invalid();
        return parseCgroupEvents(bytes.toString('utf8', 0, length));
      } finally {
        this.files.closeSync(descriptor);
      }
    } };
  }
  #verifyMount(): void {
    if (this.files.statfsSync(MOUNT_POINT).type !== CGROUP2_SUPER_MAGIC || this.files.realpathSync(MOUNT_POINT) !== MOUNT_POINT) throw invalid();
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function invalid(): SystemdContainmentError { return new SystemdContainmentError('NODE_CLEANUP_FAILED'); }
