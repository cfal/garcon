// Abstract provider base class. Concrete providers extend this and
// emit typed events; the composition root wires listeners for
// broadcasting and history cache persistence.
//
// Both emit and on wrappers are provided so the string event names
// are encapsulated here -- neither subclasses nor server.js need to
// know them.

import { EventEmitter } from 'events';

export class AbsProvider extends EventEmitter {
  // Emit helpers (used by subclasses)

  emitMessages(chatId, messages) {
    if (messages.length > 0) {
      this.emit('messages', chatId, messages);
    }
  }

  emitProcessing(chatId, isProcessing) {
    this.emit('processing', chatId, isProcessing);
  }

  emitSessionCreated(chatId) {
    this.emit('session-created', chatId);
  }

  emitFinished(chatId, exitCode = 0) {
    this.emit('finished', chatId, exitCode);
  }

  emitFailed(chatId, errorMessage) {
    this.emit('failed', chatId, errorMessage);
  }

  // Listener helpers (used by composition root)

  onMessages(cb) {
    this.on('messages', cb);
  }

  onProcessing(cb) {
    this.on('processing', cb);
  }

  onSessionCreated(cb) {
    this.on('session-created', cb);
  }

  onFinished(cb) {
    this.on('finished', cb);
  }

  onFailed(cb) {
    this.on('failed', cb);
  }
}
