(() => {
  if (window.top !== window) return;
  Object.defineProperty(window, '__GARCON_NATIVE__', {
    value: Object.freeze({
      version: 1,
      requestServerChooser() {
        window.location.assign('garcon-host://switch-server/');
      },
    }),
    writable: false,
    configurable: false,
  });
})();
