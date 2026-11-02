export async function mountLauncher(document, invoke) {
  const form = document.querySelector('#server-form');
  const input = document.querySelector('#server-url');
  const button = form.querySelector('button');
  const error = document.querySelector('#connection-error');
  let pending = false;
  let ready = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready || pending || !form.reportValidity()) return;
    pending = true;
    button.disabled = true;
    error.textContent = '';
    try {
      await invoke('connect_server', { url: input.value });
    } catch (cause) {
      error.textContent = typeof cause === 'string' ? cause : 'Unable to open the server.';
    } finally {
      pending = false;
      button.disabled = false;
    }
  });

  try {
    input.value = (await invoke('saved_server')) ?? '';
    ready = true;
    button.disabled = false;
  } catch (cause) {
    error.textContent = typeof cause === 'string' ? cause : 'Unable to read saved server settings. Restart the app to retry.';
  }
}
