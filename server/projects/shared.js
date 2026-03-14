// Provider-agnostic JSONL utilities and path normalization.

import { promises as fs } from 'fs';
import path from 'path';

export const HEAD_READ_BYTES = 32 * 1024;
export const PROJECT_PREVIEW_TAIL_BYTES = 256 * 1024;
export const PROJECT_PREVIEW_MAX_LINES_PER_FILE = 4000;

export function getMessageText(content) {
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean);
    return textParts.join('\n');
  }
  if (typeof content === 'string') {
    return content.trim();
  }
  return '';
}

// TODO: this should not be provider agnostic, only used by Claude.
export function isSystemUserMessage(text) {
  return (
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') ||
    text.startsWith('<command-args>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<system-reminder>') ||
    text.startsWith('Caveat:') ||
    text.startsWith('This session is being continued from a previous') ||
    text.startsWith('Invalid API key') ||
    text.includes('{"subtasks":') ||
    text.includes('CRITICAL: You MUST respond with ONLY a JSON') ||
    text === 'Warmup'
  );
}

export function isSystemAssistantMessage(text) {
  return (
    text.startsWith('Invalid API key') ||
    text.includes('{"subtasks":') ||
    text.includes('CRITICAL: You MUST respond with ONLY a JSON')
  );
}

// Reads the tail of a JSONL file to avoid loading the entire file into memory.
export async function readJsonlTailLines(filePath, maxBytes = PROJECT_PREVIEW_TAIL_BYTES, maxLines = PROJECT_PREVIEW_MAX_LINES_PER_FILE) {
  const stats = await fs.stat(filePath);
  const readSize = Math.min(maxBytes, stats.size);
  if (readSize === 0) {
    return { lines: [], fullyRead: true };
  }

  const fh = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    await fh.read(buffer, 0, readSize, stats.size - readSize);

    let content = buffer.toString('utf8');
    const fullyRead = readSize === stats.size;

    // Discard the first partial line when reading a tail slice
    if (!fullyRead) {
      const firstNewlineIdx = content.indexOf('\n');
      content = firstNewlineIdx >= 0 ? content.slice(firstNewlineIdx + 1) : '';
    }

    const rawLines = content.split('\n').filter(line => line.trim());
    const lines = rawLines.length > maxLines ? rawLines.slice(rawLines.length - maxLines) : rawLines;
    return { lines, fullyRead };
  } finally {
    await fh.close();
  }
}

export function normalizePath(inputPath) {
  if (typeof inputPath !== 'string') {
    return '';
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }

  let candidate = trimmed;
  if (candidate.startsWith('\\\\?\\UNC\\')) {
    candidate = `\\\\${candidate.slice('\\\\?\\UNC\\'.length)}`;
  } else if (candidate.startsWith('\\\\?\\')) {
    candidate = candidate.slice(4);
  }

  const resolved = path.resolve(candidate);
  return process.platform === 'win32'
    ? resolved.replace(/\//g, '\\').toLowerCase()
    : resolved;
}
