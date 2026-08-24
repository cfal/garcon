import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptExportResponse } from '@garcon/common/chat-export-contracts';
import type { ExportCliCommand } from './args.js';
import { argumentError, CliError } from './errors.js';
import type { CliOutput } from './output.js';

export interface TranscriptExportClient {
  getTranscriptExport(
    request: Pick<ExportCliCommand, 'chatId' | 'format' | 'exclusions'>,
    signal?: AbortSignal,
  ): Promise<TranscriptExportResponse>;
}

interface TranscriptExportFileSystem {
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

const defaultFileSystem: TranscriptExportFileSystem = {
  access: (target) => fs.access(target),
  writeFile: (target, content, options) => fs.writeFile(target, content, options),
  link: (source, destination) => fs.link(source, destination),
  rename: (source, destination) => fs.rename(source, destination),
  rm: (target, options) => fs.rm(target, options),
  randomUUID: () => crypto.randomUUID(),
};

export async function runChatExport(
  command: ExportCliCommand,
  client: TranscriptExportClient,
  output: Pick<CliOutput, 'document' | 'result'>,
  signal?: AbortSignal,
  fileSystem: TranscriptExportFileSystem = defaultFileSystem,
): Promise<void> {
  const outputPath = command.outputPath === undefined
    ? undefined
    : path.resolve(command.outputPath);
  if (outputPath !== undefined && !command.force) {
    await refuseExistingOutput(outputPath, fileSystem);
  }

  const response = await client.getTranscriptExport({
    chatId: command.chatId,
    format: command.format,
    exclusions: command.exclusions,
  }, signal);
  signal?.throwIfAborted();

  if (outputPath === undefined) {
    output.document(response.document);
    return;
  }

  await writeAtomically(outputPath, response.document, command.force, signal, fileSystem);
  const omitted = response.omitted.map(({ category, count }) => `${category} ${count}`).join(', ');
  output.result([
    `chat id: ${response.chatId}`,
    `format: ${response.format}`,
    `output: ${outputPath}`,
    `transcript view id: ${response.transcriptViewId}`,
    `last ordinal: ${response.lastOrdinal}`,
    `entries: ${response.entryCount}`,
    `omitted: ${omitted || 'none'}`,
    `bytes: ${new TextEncoder().encode(response.document).byteLength}`,
  ].join('\n'));
}

async function refuseExistingOutput(
  outputPath: string,
  fileSystem: TranscriptExportFileSystem,
): Promise<void> {
  try {
    await fileSystem.access(outputPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new CliError('export', `cannot inspect output path: ${outputPath}`, 3, { cause: error });
  }
  throw argumentError(`output already exists; use --force to replace it: ${outputPath}`);
}

async function writeAtomically(
  outputPath: string,
  document: string,
  force: boolean,
  signal: AbortSignal | undefined,
  fileSystem: TranscriptExportFileSystem,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.garcon-export-${fileSystem.randomUUID()}.tmp`,
  );
  try {
    await fileSystem.writeFile(temporaryPath, document, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    signal?.throwIfAborted();
    if (force) {
      await fileSystem.rename(temporaryPath, outputPath);
    } else {
      try {
        await fileSystem.link(temporaryPath, outputPath);
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) {
          throw argumentError(`output already exists; use --force to replace it: ${outputPath}`);
        }
        if (isNodeError(error, 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK')) {
          throw new CliError(
            'export',
            `output filesystem does not support atomic no-overwrite publication; use --force or choose a different destination: ${outputPath}`,
            3,
            { cause: error },
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof CliError) throw error;
    throw new CliError('export', `failed to write transcript export: ${outputPath}`, 3, {
      cause: error,
    });
  } finally {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isNodeError(error: unknown, ...codes: readonly string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}
