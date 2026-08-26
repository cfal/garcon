import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { argumentError, CliError, type CliErrorPhase } from './errors.js';

export interface AtomicDocumentFileSystem {
  access(path: string): Promise<void>;
  writeFile(path: string, content: string, options: {
    encoding: 'utf8';
    flag: 'wx';
    mode: 0o600;
  }): Promise<void>;
  link(source: string, destination: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  randomUUID(): string;
}

const defaultFileSystem: AtomicDocumentFileSystem = {
  access: (target) => fs.access(target),
  writeFile: (target, content, options) => fs.writeFile(target, content, options),
  link: (source, destination) => fs.link(source, destination),
  rename: (source, destination) => fs.rename(source, destination),
  rm: (target, options) => fs.rm(target, options),
  randomUUID: () => crypto.randomUUID(),
};

export async function refuseExistingDocumentOutput(input: {
  readonly outputPath: string;
  readonly phase: CliErrorPhase;
  readonly noun: string;
  readonly fileSystem?: AtomicDocumentFileSystem;
}): Promise<void> {
  const fileSystem = input.fileSystem ?? defaultFileSystem;
  try {
    await fileSystem.access(input.outputPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new CliError(
      input.phase,
      `cannot inspect ${input.noun} output path: ${input.outputPath}`,
      3,
      { cause: error },
    );
  }
  throw argumentError(
    `output already exists; use --force to replace it: ${input.outputPath}`,
  );
}

export async function publishAtomicDocument(input: {
  readonly outputPath: string;
  readonly document: string;
  readonly force: boolean;
  readonly phase: CliErrorPhase;
  readonly noun: string;
  readonly temporarySuffix: string;
  readonly signal?: AbortSignal;
  readonly fileSystem?: AtomicDocumentFileSystem;
}): Promise<void> {
  const fileSystem = input.fileSystem ?? defaultFileSystem;
  const temporaryPath = path.join(
    path.dirname(input.outputPath),
    `.${path.basename(input.outputPath)}.${input.temporarySuffix}-${fileSystem.randomUUID()}.tmp`,
  );
  try {
    await fileSystem.writeFile(temporaryPath, input.document, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    input.signal?.throwIfAborted();
    if (input.force) {
      await fileSystem.rename(temporaryPath, input.outputPath);
    } else {
      try {
        await fileSystem.link(temporaryPath, input.outputPath);
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) {
          throw argumentError(
            `output already exists; use --force to replace it: ${input.outputPath}`,
          );
        }
        if (isNodeError(error, 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK')) {
          throw new CliError(
            input.phase,
            `output filesystem does not support atomic no-overwrite publication; use --force or choose a different destination: ${input.outputPath}`,
            3,
            { cause: error },
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (error instanceof CliError) throw error;
    throw new CliError(
      input.phase,
      `failed to write ${input.noun}: ${input.outputPath}`,
      3,
      { cause: error },
    );
  } finally {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isNodeError(error: unknown, ...codes: readonly string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}
