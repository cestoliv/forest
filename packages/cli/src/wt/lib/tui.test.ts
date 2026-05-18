// src/lib/tui.test.ts
import { describe, expect, it } from 'vitest';
import type { Worktree } from './git.js';
import {
  filterItems,
  groupByRepo,
  renderBranchInput,
  renderList,
  renderRepoPicker,
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

  it('shows C create hint in repo mode but not global mode', () => {
    const repoOutput = renderList(items, 0, '', 'repo');
    expect(repoOutput).toContain('C create');

    const globalOutput = renderList(items, 0, '', 'global');
    expect(globalOutput).not.toContain('C create');
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
    const linesWithout = renderList(withoutCommit, 0, '', 'repo').split(
      '\n',
    ).length;
    const linesWith = renderList(withCommit, 0, '', 'repo').split('\n').length;
    expect(linesWith).toBe(linesWithout + 1);
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
