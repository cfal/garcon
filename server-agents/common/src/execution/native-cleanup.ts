/** Records cleanup failures that leave native quiescence unconfirmed. */
export interface NativeCleanupObserver {
  failed(error: unknown): void;
}
