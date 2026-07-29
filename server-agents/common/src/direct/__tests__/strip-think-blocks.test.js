import { describe, expect, it } from 'bun:test';
import { stripThinkBlocks } from '../strip-think-blocks.ts';

describe('stripThinkBlocks', () => {
  it('removes multiline and repeated think blocks before trimming', () => {
    expect(stripThinkBlocks(
      ' \n<think>\nprivate reasoning\n</think>\nVisible\n<THINK mode="deep">more</THINK>\n ',
    )).toBe('Visible');
  });

  it('removes an unterminated think block through the end of the response', () => {
    expect(stripThinkBlocks('Visible\n<think>unfinished')).toBe('Visible');
    expect(stripThinkBlocks('<think>only reasoning')).toBe('');
  });

  it('removes orphan closing tags without changing adjacent visible text', () => {
    expect(stripThinkBlocks('Visible</think> text')).toBe('Visible text');
  });

  it('preserves visible formatting and unrelated markup', () => {
    expect(stripThinkBlocks('  feat: subject\n\nBody line  ')).toBe(
      'feat: subject\n\nBody line',
    );
    expect(stripThinkBlocks('<thinkingly>visible</thinkingly>')).toBe(
      '<thinkingly>visible</thinkingly>',
    );
  });
});
