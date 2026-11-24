import { ObserverReloadService, reloadOutcomeUnknown, type ObserverReloadOptions } from './observer-reload.js';
import { TranscriptReloadService, type TranscriptReloadOptions, type TranscriptReloadServiceOptions } from './reload.js';
import type { TranscriptViewReader } from './view-reader.js';

export function createChatReloader(options: TranscriptReloadServiceOptions
  & Pick<ObserverReloadOptions, 'observers'> & { reader: Pick<TranscriptViewReader, 'page'> }) {
  const executable = new TranscriptReloadService(options);
  const observer = new ObserverReloadService(options);
  return async (chatId: string, request: TranscriptReloadOptions) => {
    const service = options.registry.getChat(chatId)?.nativeObservation ? observer : executable;
    const replacement = await service.reload(chatId, request);
    try { return await options.reader.page(chatId, 100, undefined, replacement.viewId); }
    catch (error) { throw reloadOutcomeUnknown(error); }
  };
}
