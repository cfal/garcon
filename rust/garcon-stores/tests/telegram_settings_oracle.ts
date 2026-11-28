import { TelegramSettingsStore } from '../../../server/controller/notifications/telegram-settings-store.ts';

const [action, path] = Bun.argv.slice(2);
const store = new TelegramSettingsStore(path);
await store.init();
if (action === 'link') {
  await store.setBotToken('  fixture-token  ', { id: 123, username: '@@Garcon_BOT', firstName: 'Garcon' });
  await store.beginRecipientLink();
  console.log(JSON.stringify(store.getPublicStatus()));
} else if (action === 'clear') {
  console.log(JSON.stringify(store.getPublicStatus()));
  await store.clearRecipient();
} else if (action === 'normalize') {
  console.log(JSON.stringify(store.getPublicStatus()));
} else {
  throw new Error(`Unknown Telegram oracle action: ${action}`);
}
