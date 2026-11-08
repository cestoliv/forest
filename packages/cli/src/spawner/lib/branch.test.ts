import { describe, expect, it } from 'vitest';
import { buildBranchName, parseTaskId, slugify } from './branch.js';

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('Fix login redirect loop')).toBe('fix-login-redirect-loop');
  });
  it('collapses punctuation and trims dashes', () => {
    expect(slugify('  Hello, World!!  ')).toBe('hello-world');
  });
  it('handles unicode/emoji by stripping to ascii words', () => {
    expect(slugify('📱 Mobile crash')).toBe('mobile-crash');
  });
  it('falls back to "task" for empty/punctuation-only input', () => {
    expect(slugify('   ')).toBe('task');
    expect(slugify('!!!')).toBe('task');
  });
  it('caps length without a trailing dash', () => {
    const s = slugify(`${'a'.repeat(40)} ${'b'.repeat(40)}`);
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.endsWith('-')).toBe(false);
  });
});

describe('buildBranchName', () => {
  it('combines prefix, slug, and id', () => {
    expect(buildBranchName('agent/', 'Fix login', '6XGg')).toBe(
      'agent/fix-login-6XGg',
    );
  });
});

describe('parseTaskId', () => {
  it('inverts buildBranchName for a v1 id, with or without a prefix', () => {
    for (const prefix of ['', 'agent/']) {
      const branch = buildBranchName(
        prefix,
        'Add gender field',
        '6hMvpJ6h8pFV8Fg4',
      );
      expect(parseTaskId(branch)).toBe('6hMvpJ6h8pFV8Fg4');
    }
  });
  it('reads a legacy numeric id', () => {
    expect(parseTaskId('fix-crash-8483726192')).toBe('8483726192');
  });
  it('finds no id in a hand-made branch', () => {
    for (const branch of [
      'todoist-finish-on-prune',
      'fix-login-2',
      'main',
      'feat/abcdefghijklmnop',
      'bump-20261108',
    ]) {
      expect(parseTaskId(branch)).toBeNull();
    }
  });
});
