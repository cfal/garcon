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

  it('treats text before an orphan closing tag as reasoning with a lost opening tag', () => {
    expect(stripThinkBlocks('leaked reasoning</think>\nVisible')).toBe('Visible');
    expect(stripThinkBlocks('first</think>second</think>\nVisible')).toBe('Visible');
    expect(stripThinkBlocks('reasoning only</think >')).toBe('');
  });

  it('removes nested think blocks without leaking the outer block', () => {
    expect(stripThinkBlocks(
      '<think>outer<think>inner</think>still outer</think>\nVisible',
    )).toBe('Visible');
    expect(stripThinkBlocks(
      'Subject line\n<think>outer<think>inner</think>still outer</think>\nBody',
    )).toBe('Subject line\n\nBody');
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
