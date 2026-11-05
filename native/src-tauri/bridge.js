(titlebarHidden => {
  if (window.top !== window) return;
  let titlebarSnapshot = Object.freeze({ hidden: titlebarHidden, failed: false });
  const titlebarListeners = new Set();
  window.addEventListener('garcon-titlebar-state', ({ detail }) => {
    if (typeof detail?.hidden !== 'boolean' || typeof detail?.failed !== 'boolean') return;
    titlebarSnapshot = Object.freeze({ hidden: detail.hidden, failed: detail.failed });
    for (const listener of titlebarListeners) listener(titlebarSnapshot);
  });
  Object.defineProperty(window, '__GARCON_NATIVE__', {
    value: Object.freeze({
      version: 1,
      requestServerChooser() {
        window.location.assign('garcon-host://switch-server/');
      },
      titlebar: Object.freeze({
        requestHidden(hidden) {
          if (typeof hidden !== 'boolean') throw new TypeError('Expected titlebar visibility');
          window.location.assign(hidden ? 'garcon-host://hide-titlebar/' : 'garcon-host://show-titlebar/');
        },
        subscribe(listener) {
          listener(titlebarSnapshot);
          titlebarListeners.add(listener);
          return () => titlebarListeners.delete(listener);
        },
      }),
    }),
    writable: false,
    configurable: false,
  });
})
