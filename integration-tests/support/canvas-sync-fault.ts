import { existsSync, promises as fs } from 'node:fs';

const directory = process.env.GARCON_TEST_CANVAS_DIRECTORY;
const failureFile = process.env.GARCON_TEST_CANVAS_SYNC_FAILURE;
if (!directory || !failureFile) throw new Error('Canvas sync fault paths are required');
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  if (args[0] === directory) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (existsSync(failureFile)) {
        throw Object.assign(new Error('Injected canvas directory sync failure'), { code: 'EIO' });
      }
      await sync();
    };
  }
  return handle;
};
