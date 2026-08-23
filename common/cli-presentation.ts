export const CLI_PRESENTATION_STYLES = ['info', 'notice', 'error'] as const;
export type CliPresentationStyle = (typeof CLI_PRESENTATION_STYLES)[number];

export const CLI_PRESENTATION_STYLE_LIST = CLI_PRESENTATION_STYLES.join(', ');

export function isCliPresentationStyle(value: unknown): value is CliPresentationStyle {
  return (CLI_PRESENTATION_STYLES as readonly unknown[]).includes(value);
}
