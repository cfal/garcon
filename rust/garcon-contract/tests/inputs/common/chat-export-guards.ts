import { isTranscriptExportCategory } from "../../../../../common/chat-export-contracts.ts";

export function isTranscriptExportCategoryArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isTranscriptExportCategory);
}
