// src/lib/tui.test.ts
import { describe, expect, it } from 'vitest';
import type { Worktree } from './git.js';
import {
  buildListLayout,
  clampScroll,
  filterItems,
  groupByRepo,
  renderBranchInput,
  renderList,
  renderRepoPicker,
  runWizard,
} from './tui.js';

const items: Worktree[] = [
  {
    path: '/projects/repo',
    branch: 'main',
    isCurrent: true,
    repoRoot: '/projects/repo',
  },
  {
    path: '/projects/repo-feature',
    branch: 'my-feature',
    isCurrent: false,
    repoRoot: '/projects/repo',
  },
  {
    path: '/projects/other',
    branch: 'main',
    isCurrent: false,
    repoRoot: '/projects/other',
  },
];

describe('filterItems', () => {
  it('returns all items for empty query', () => {
    expect(filterItems(items, '')).toHaveLength(3);
  });

  it('filters by branch name', () => {
    const result = filterItems(items, 'feature');
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe('my-feature');
  });

  it('returns empty array when nothing matches', () => {
    expect(filterItems(items, 'zzznomatch')).toHaveLength(0);
  });
});

describe('groupByRepo', () => {
  it('groups worktrees by repoRoot', () => {
    const groups = groupByRepo(items);
    expect(groups.size).toBe(2);
    expect(groups.get('/projects/repo')).toHaveLength(2);
    expect(groups.get('/projects/other')).toHaveLength(1);
  });

  it('preserves insertion order', () => {
    const groups = groupByRepo(items);
    const keys = [...groups.keys()];
    expect(keys[0]).toBe('/projects/repo');
    expect(keys[1]).toBe('/projects/other');
  });
});

describe('renderList', () => {
  it('includes branch names', () => {
    const output = renderList(items, 0, '', 'repo');
    expect(output).toContain('main');
    expect(output).toContain('my-feature');
  });

  it('includes worktree paths', () => {
    const output = renderList(items, 0, '', 'repo');
    expect(output).toContain('/projects/repo');
    expect(output).toContain('/projects/repo-feature');
  });

  it('includes the search query', () => {
    const output = renderList(items, 0, 'feat', 'repo');
    expect(output).toContain('feat');
  });

  it('includes navigation hint', () => {
    const output = renderList(items, 0, '', 'repo');
    expect(output).toContain('↕ navigate');
  });

  it('shows info line in global mode but not repo mode', () => {
    const repoOutput = renderList(items, 0, '', 'repo');
    expect(repoOutput).not.toContain('Not in a git repository');

    const globalOutput = renderList(items, 0, '', 'global');
    expect(globalOutput).toContain('Not in a git repository');
  });

  it('shows C create and A agent hints in both repo and global mode', () => {
    const repoOutput = renderList(items, 0, '', 'repo');
    expect(repoOutput).toContain('C create');
    expect(repoOutput).toContain('A agent');

    const globalOutput = renderList(items, 0, '', 'global');
    expect(globalOutput).toContain('C create');
    expect(globalOutput).toContain('A agent');
  });

  it('shows repo section headers in both modes', () => {
    const repoOutput = renderList(items, 0, '', 'repo');
    expect(repoOutput).toContain('REPO');
    expect(repoOutput).toContain('OTHER');

    const globalOutput = renderList(items, 0, '', 'global');
    expect(globalOutput).toContain('REPO');
    expect(globalOutput).toContain('OTHER');
  });

  it('shows lastCommit on a second line when set', () => {
    const withCommit: Worktree[] = [
      {
        path: '/projects/repo',
        branch: 'main',
        isCurrent: true,
        repoRoot: '/projects/repo',
        lastCommit: 'fix: correct login redirect',
      },
    ];
    const output = renderList(withCommit, 0, '', 'repo');
    expect(output).toContain('fix: correct login redirect');
  });

  it('does not render an extra line when lastCommit is empty', () => {
    const withoutCommit: Worktree[] = [
      {
        path: '/projects/repo',
        branch: 'main',
        isCurrent: true,
        repoRoot: '/projects/repo',
        lastCommit: '',
      },
    ];
    const withCommit: Worktree[] = [
      {
        path: '/projects/repo',
        branch: 'main',
        isCurrent: true,
        repoRoot: '/projects/repo',
        lastCommit: 'some commit',
      },
    ];
    const linesWithout = buildListLayout(withoutCommit, 0, '', 'repo').body
      .length;
    const linesWith = buildListLayout(withCommit, 0, '', 'repo').body.length;
    expect(linesWith).toBe(linesWithout + 1);
  });
});

describe('buildListLayout', () => {
  it('splits header, body and footer per mode', () => {
    const repo = buildListLayout(items, 0, '', 'repo');
    expect(repo.header.join('\n')).not.toContain('Not in a git repository');
    expect(repo.header.join('\n')).toContain('> _');
    expect(repo.footer.join('\n')).toContain('↕ navigate');
    expect(repo.footer.join('\n')).toContain('C create');
    expect(repo.footer.join('\n')).toContain('A agent');

    const global = buildListLayout(items, 0, '', 'global');
    expect(global.header.join('\n')).toContain('Not in a git repository');
    expect(global.footer.join('\n')).toContain('C create');
    expect(global.footer.join('\n')).toContain('A agent');
  });

  it('puts repo group headers and items in the body', () => {
    const { body } = buildListLayout(items, 0, '', 'repo');
    const text = body.join('\n');
    expect(text).toContain('REPO');
    expect(text).toContain('OTHER');
    expect(text).toContain('my-feature');
  });

  it('tracks a one-line span for items without a lastCommit', () => {
    const { itemSpans } = buildListLayout(items, 0, '', 'repo');
    expect(itemSpans).toHaveLength(3);
    for (const span of itemSpans) {
      expect(span.end).toBe(span.start);
    }
  });

  it('tracks a two-line span for items with a lastCommit', () => {
    const withCommit: Worktree[] = [
      {
        path: '/projects/repo',
        branch: 'main',
        isCurrent: true,
        repoRoot: '/projects/repo',
        lastCommit: 'fix: thing',
      },
    ];
    const { itemSpans } = buildListLayout(withCommit, 0, '', 'repo');
    expect(itemSpans[0].end).toBe(itemSpans[0].start + 1);
  });
});

describe('clampScroll', () => {
  it('returns 0 when everything fits', () => {
    expect(clampScroll(0, { start: 5, end: 5 }, 20, 10)).toBe(0);
  });

  it('scrolls up when the selection is above the window', () => {
    expect(clampScroll(8, { start: 3, end: 3 }, 5, 30)).toBe(3);
  });

  it('scrolls down when the selection is below the window', () => {
    // viewport 5, selected end at line 12 -> offset 12 - 5 + 1 = 8
    expect(clampScroll(0, { start: 12, end: 12 }, 5, 30)).toBe(8);
  });

  it('leaves a stable offset unchanged when the selection is in view', () => {
    expect(clampScroll(8, { start: 9, end: 9 }, 5, 30)).toBe(8);
  });

  it('never exceeds the maximum offset', () => {
    expect(clampScroll(0, { start: 29, end: 29 }, 5, 30)).toBe(25);
  });
});

describe('renderList viewport', () => {
  const many: Worktree[] = Array.from({ length: 30 }, (_, n) => ({
    path: `/projects/repo-${n}`,
    branch: `branch-${n}`,
    isCurrent: false,
    repoRoot: '/projects/repo',
  }));

  it('never renders more lines than the terminal height', () => {
    const lineCount = renderList(many, 0, '', 'repo', 10).split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(10);
  });

  it('always keeps the search line and footer visible', () => {
    const output = renderList(many, 0, '', 'repo', 10);
    expect(output).toContain('> _');
    expect(output).toContain('↕ navigate');
  });

  it('keeps the selected item visible when it is far down the list', () => {
    const output = renderList(many, 29, '', 'repo', 10);
    expect(output).toContain('branch-29');
  });

  it('shows a down indicator but no up indicator at the top', () => {
    const output = renderList(many, 0, '', 'repo', 10);
    expect(output).toContain('↓ more');
    expect(output).not.toContain('↑ more');
  });

  it('shows an up indicator once scrolled to the bottom', () => {
    const output = renderList(many, 29, '', 'repo', 10);
    expect(output).toContain('↑ more');
    expect(output).not.toContain('↓ more');
  });

  it('pins the footer to the bottom when content is shorter than the terminal', () => {
    const lines = renderList(items, 0, '', 'repo', 20).split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[lines.length - 1]).toContain('↕ navigate');
  });
});

describe('renderRepoPicker', () => {
  const repos = ['/projects/my-repo', '/projects/other-repo'];

  it('shows the info header', () => {
    expect(renderRepoPicker(repos, 0, '')).toContain('Not in a git repository');
  });

  it('shows the search query', () => {
    expect(renderRepoPicker(repos, 0, 'my')).toContain('my');
  });

  it('shows repo basenames in uppercase', () => {
    const output = renderRepoPicker(repos, 0, '');
    expect(output).toContain('MY-REPO');
    expect(output).toContain('OTHER-REPO');
  });

  it('shows cursor only on the selected repo', () => {
    const out0 = renderRepoPicker(repos, 0, '');
    const repoLines0 = out0
      .split('\n')
      .filter((l) => l.includes('MY-REPO') || l.includes('OTHER-REPO'));
    expect(repoLines0[0]).toContain('▶');
    expect(repoLines0[1]).not.toContain('▶');

    const out1 = renderRepoPicker(repos, 1, '');
    const repoLines1 = out1
      .split('\n')
      .filter((l) => l.includes('MY-REPO') || l.includes('OTHER-REPO'));
    expect(repoLines1[0]).not.toContain('▶');
    expect(repoLines1[1]).toContain('▶');
  });

  it('shows navigation hint', () => {
    const output = renderRepoPicker(repos, 0, '');
    expect(output).toContain('↕ navigate');
    expect(output).toContain('Enter select');
  });
});

describe('renderBranchInput', () => {
  it('shows the repo name', () => {
    expect(renderBranchInput('my-repo', '')).toContain('my-repo');
  });

  it('shows the current branch text', () => {
    expect(renderBranchInput('my-repo', 'fix/AIA-1178')).toContain(
      'fix/AIA-1178',
    );
  });

  it('shows a cursor marker', () => {
    expect(renderBranchInput('my-repo', 'fix/foo')).toContain('_');
  });

  it('shows error when provided', () => {
    expect(
      renderBranchInput('my-repo', '', 'Branch name is required'),
    ).toContain('Branch name is required');
  });

  it('shows no error when not provided', () => {
    expect(renderBranchInput('my-repo', 'main')).not.toContain('required');
  });

  it('shows navigation hint', () => {
    const output = renderBranchInput('my-repo', '');
    expect(output).toContain('Enter confirm');
    expect(output).toContain('Esc cancel');
  });
});

describe('runWizard', () => {
  it('advances through every step and resolves true', async () => {
    const calls: number[] = [];
    const steps = [0, 1, 2].map((n) => async () => {
      calls.push(n);
      return true;
    });
    expect(await runWizard(steps)).toBe(true);
    expect(calls).toEqual([0, 1, 2]);
  });

  it('resolves false when the first step cancels', async () => {
    const calls: string[] = [];
    const steps = [
      async () => {
        calls.push('a');
        return false;
      },
      async () => {
        calls.push('b');
        return true;
      },
    ];
    expect(await runWizard(steps)).toBe(false);
    expect(calls).toEqual(['a']); // never reaches step b
  });

  it('steps back to the previous step on cancel, then continues', async () => {
    const calls: string[] = [];
    let firstTry = true;
    const steps = [
      async () => {
        calls.push('a');
        return true;
      },
      async () => {
        calls.push('b');
        if (firstTry) {
          firstTry = false;
          return false; // go back to step a once
        }
        return true;
      },
      async () => {
        calls.push('c');
        return true;
      },
    ];
    expect(await runWizard(steps)).toBe(true);
    expect(calls).toEqual(['a', 'b', 'a', 'b', 'c']);
  });

  it('resolves true for an empty step list', async () => {
    expect(await runWizard([])).toBe(true);
  });
});
