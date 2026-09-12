import { ChatRegistry } from '../../server/chats/store.js';
import { DomainError } from '../../server/lib/domain-error.js';

const refusedModel = process.env.GARCON_TEST_REFUSED_SETTINGS_MODEL;
if (!refusedModel) throw new Error('Settings-save fixture requires its refused model');

const saveRegistry = ChatRegistry.prototype.saveRegistry;
ChatRegistry.prototype.saveRegistry = async function (registry, onWriteFailure) {
  if (Object.values(registry.sessions).some((entry) => entry.agentId === 'claude' && entry.model === refusedModel)) {
    onWriteFailure?.();
    throw new DomainError('SOURCE_REVISION_CHANGED', 'Synthetic registry save refusal', 409);
  }
  await saveRegistry.call(this, registry, onWriteFailure);
};
