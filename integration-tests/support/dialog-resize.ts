export async function pauseDialogResize(control: HTMLElement): Promise<Animation> {
  control.click();
  await new Promise(requestAnimationFrame);
  const animation = control.closest('[role="dialog"]')!.getAnimations()
    .find(candidate => candidate.id === 'dialog-resize')!;
  animation.pause();
  return animation;
}

// Runs inside locator.evaluate so all three measurements see the same dialog and animation.
export async function measureDialogHeightChange(control: HTMLElement, options?: { widthSelector?: string }) {
  const dialog = control.closest<HTMLElement>('[role="dialog"]')!;
  const field = options?.widthSelector ? dialog.querySelector<HTMLElement>(options.widthSelector) : null;
  const widths: number[] = [];
  const measure = () => {
    if (field) widths.push(field.offsetWidth);
    return dialog.offsetHeight;
  };
  const before = measure();
  control.click();
  await new Promise(requestAnimationFrame);

  const resize = dialog.getAnimations().find(animation => animation.id === 'dialog-resize');
  if (resize) {
    resize.pause();
    resize.currentTime = Number(resize.effect!.getTiming().duration) / 2;
  }
  const middle = measure();
  resize?.finish();
  return { before, middle, after: measure(), widths };
}
