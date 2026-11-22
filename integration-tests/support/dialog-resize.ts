// Runs inside locator.evaluate so all three measurements see the same dialog and animation.
export async function measureDialogHeightChange(control: HTMLElement, options?: { focus: boolean }) {
  const dialog = control.closest<HTMLElement>('[role="dialog"]')!;
  const before = dialog.offsetHeight;
  if (options?.focus) control.focus();
  control.click();
  await new Promise(requestAnimationFrame);

  const resize = dialog.getAnimations().find(animation => animation.id === 'dialog-resize');
  if (resize) {
    resize.pause();
    resize.currentTime = Number(resize.effect!.getTiming().duration) / 2;
  }
  const middle = dialog.offsetHeight;
  resize?.finish();
  return { before, middle, after: dialog.offsetHeight, focused: document.activeElement === control };
}
