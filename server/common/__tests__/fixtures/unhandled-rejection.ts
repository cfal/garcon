import { installUnhandledRejectionPolicy } from '../../unhandled-rejection-policy.js';

const initial = process.listenerCount('unhandledRejection');
const uninstall = installUnhandledRejectionPolicy({
  error: (...details) => { console.log(JSON.stringify({ type: 'unhandled-rejection', details })); },
});
if (process.argv[2] === 'remove') {
  uninstall();
  uninstall();
  console.log(JSON.stringify({ listenersRestored: process.listenerCount('unhandledRejection') === initial }));
} else {
  Promise.reject(new Error('synthetic detached failure'));
  setTimeout(() => {
    console.log('still-alive');
    uninstall();
  }, 20);
}
