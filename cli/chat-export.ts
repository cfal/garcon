import path from 'node:path';
import type { TranscriptExportResponse } from '@garcon/common/chat-export-contracts';
import type { ExportCliCommand } from './args.js';
import {
  publishAtomicDocument,
  refuseExistingDocumentOutput,
  type AtomicDocumentFileSystem,
} from './atomic-document-output.js';
import type { CliOutput } from './output.js';

export interface TranscriptExportClient {
  getTranscriptExport(
    request: Pick<ExportCliCommand, 'chatId' | 'format' | 'exclusions'>,
    signal?: AbortSignal,
  ): Promise<TranscriptExportResponse>;
}

export async function runChatExport(
  command: ExportCliCommand,
  client: TranscriptExportClient,
  output: Pick<CliOutput, 'document' | 'result'>,
  signal?: AbortSignal,
  fileSystem?: AtomicDocumentFileSystem,
): Promise<void> {
  const outputPath = command.outputPath === undefined
    ? undefined
    : path.resolve(command.outputPath);
  if (outputPath !== undefined && !command.force) {
    await refuseExistingDocumentOutput({
      outputPath,
      phase: 'export',
      noun: 'transcript export',
      fileSystem,
    });
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

  await publishAtomicDocument({
    outputPath,
    document: response.document,
    force: command.force,
    phase: 'export',
    noun: 'transcript export',
    temporarySuffix: 'garcon-export',
    signal,
    fileSystem,
  });
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
