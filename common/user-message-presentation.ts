import { parseChatRowTitle } from './chat-row-contracts.js';
import {
  isCliBodyDisclosure,
  isCliPresentation,
  type CliPresentation,
} from './cli-presentation.js';

export type UserMessagePresentation =
  | ({
    readonly origin: 'cli';
    readonly title?: string;
    readonly disclosure?: 'collapsed';
  } & CliPresentation)
  | {
    readonly origin: 'cli';
    readonly disclosure: 'collapsed';
    readonly style?: undefined;
    readonly customStyle?: undefined;
    readonly title?: undefined;
  };

export function parseUserMessagePresentation(value: unknown): UserMessagePresentation | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('user message presentation must be an object');
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!['origin', 'style', 'customStyle', 'title', 'disclosure'].includes(key)) {
      throw new TypeError(`user message presentation contains unsupported field: ${key}`);
    }
  }
  if (body.origin !== 'cli') throw new TypeError('user message presentation origin must be cli');
  const disclosure = body.disclosure;
  if (disclosure !== undefined && !isCliBodyDisclosure(disclosure)) {
    throw new TypeError('user message presentation disclosure is invalid');
  }
  const presentation = {
    style: body.style,
    ...(body.customStyle === undefined ? {} : { customStyle: body.customStyle }),
  };
  const title = parseChatRowTitle(body.title);
  if (body.style === undefined) {
    if (disclosure !== 'collapsed') {
      throw new TypeError('styleless user message presentation must be collapsed');
    }
    if (body.customStyle !== undefined || title !== undefined) {
      throw new TypeError('styleless user message presentation cannot carry a title or custom style');
    }
    return { origin: 'cli', disclosure };
  }
  if (!isCliPresentation(presentation)) throw new TypeError('user message presentation is invalid');
  return {
    origin: 'cli',
    ...presentation,
    ...(title === undefined ? {} : { title }),
    ...(disclosure === 'collapsed' ? { disclosure } : {}),
  };
}
