import { describe, expect, it } from 'vitest';
import type { RouteRule } from './config.js';
import { resolveRoute } from './router.js';

const rules: RouteRule[] = [
  { project: 'OVL', labels: ['mobile'], path: '/repos/mobile' },
  { project: 'OVL', labels: ['backend'], path: '/repos/backend' },
  { project: 'WEB', path: '/repos/website' },
];

describe('resolveRoute', () => {
  it('matches project + label specific rule', () => {
    expect(resolveRoute(rules, 'OVL', ['mobile'])).toBe('/repos/mobile');
    expect(resolveRoute(rules, 'OVL', ['backend'])).toBe('/repos/backend');
  });

  it('honours rule order (first match wins)', () => {
    expect(resolveRoute(rules, 'OVL', ['mobile', 'backend'])).toBe(
      '/repos/mobile',
    );
  });

  it('matches a catch-all rule with no labels', () => {
    expect(resolveRoute(rules, 'WEB', [])).toBe('/repos/website');
    expect(resolveRoute(rules, 'WEB', ['anything'])).toBe('/repos/website');
  });

  it('returns null when no rule matches the project', () => {
    expect(resolveRoute(rules, 'OTHER', ['mobile'])).toBeNull();
  });

  it('returns null when project matches but required labels are absent', () => {
    expect(resolveRoute(rules, 'OVL', ['something-else'])).toBeNull();
  });

  it('requires all listed labels to be present', () => {
    const multi: RouteRule[] = [
      { project: 'P', labels: ['a', 'b'], path: '/p' },
    ];
    expect(resolveRoute(multi, 'P', ['a'])).toBeNull();
    expect(resolveRoute(multi, 'P', ['a', 'b'])).toBe('/p');
  });
});
