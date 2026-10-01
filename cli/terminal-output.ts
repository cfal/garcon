const unsafeControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const escapedControl = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

export function terminalLine(text: string): string {
  return text.replace(unsafeControls, escapedControl);
}

export function terminalBody(text: string): string {
  return text.replace(unsafeControls, (character) => character === '\n' || character === '\t' ? character : escapedControl(character));
}
