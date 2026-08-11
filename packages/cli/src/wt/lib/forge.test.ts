// src/lib/forge.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildClosedQuery,
  buildMergedQuery,
  type ForgeRunner,
  hasClosedPullRequest,
  hasMergedPullRequest,
  parseClosedResult,
  parseMergedResult,
  parseRemoteHost,
  selectForgeTool,
} from './forge.js';

describe('parseRemoteHost', () => {
  it('parses scp-like SSH remotes', () => {
    expect(parseRemoteHost('git@github.com:owner/repo.git')).toBe('github.com');
    expect(parseRemoteHost('git@git.chevro.fr:cestoliv/board.git')).toBe(
      'git.chevro.fr',
    );
  });

  it('parses https remotes (with optional credentials)', () => {
    expect(parseRemoteHost('https://github.com/owner/repo.git')).toBe(
      'github.com',
    );
    expect(parseRemoteHost('https://user@gitlab.com/owner/repo')).toBe(
      'gitlab.com',
    );
  });

  it('parses ssh:// remotes with a port', () => {
    expect(
      parseRemoteHost('ssh://git@git.example.com:2222/owner/repo.git'),
    ).toBe('git.example.com');
  });

  it('lowercases the host', () => {
    expect(parseRemoteHost('git@GitHub.com:owner/repo.git')).toBe('github.com');
  });

  it('returns null for empty or unparseable input', () => {
    expect(parseRemoteHost('')).toBeNull();
    expect(parseRemoteHost('   ')).toBeNull();
  });
});

describe('selectForgeTool', () => {
  it('maps github.com to gh', () => {
    expect(selectForgeTool('github.com')).toBe('gh');
  });

  it('maps github.* Enterprise hosts and *.github.com subdomains to gh', () => {
    expect(selectForgeTool('github.acme.com')).toBe('gh');
    expect(selectForgeTool('api.github.com')).toBe('gh');
  });

  it('maps gitlab.com and self-hosted gitlab to glab', () => {
    expect(selectForgeTool('gitlab.com')).toBe('glab');
    expect(selectForgeTool('git.chevro.fr')).toBe('glab');
  });

  it('does not misroute non-GitHub hosts that merely contain "github"', () => {
    expect(selectForgeTool('gitlab.githubcorp.com')).toBe('glab');
    expect(selectForgeTool('gitlab.github.io')).toBe('glab');
  });

  it('returns null for a null host', () => {
    expect(selectForgeTool(null)).toBeNull();
  });
});

describe('buildMergedQuery', () => {
  it('builds a gh query filtered to merged PRs for the head and base branches', () => {
    expect(buildMergedQuery('gh', 'feat/x', 'main')).toEqual([
      'pr',
      'list',
      '--head',
      'feat/x',
      '--base',
      'main',
      '--state',
      'merged',
      '--json',
      'number',
    ]);
  });

  it('builds a glab query filtered to merged MRs for the source and target branches', () => {
    expect(buildMergedQuery('glab', 'feat/x', 'main')).toEqual([
      'mr',
      'list',
      '--merged',
      '--source-branch',
      'feat/x',
      '--target-branch',
      'main',
      '-F',
      'json',
    ]);
  });
});

describe('buildClosedQuery', () => {
  it('builds a gh query over every state for the head and base branches', () => {
    // Deliberately `--state all`, not `--state closed`: deciding "this branch is
    // dead" needs to see a *still-open* PR on the same head/base too, and one
    // query keeps both facts consistent (see `parseClosedResult`).
    expect(buildClosedQuery('gh', 'feat/x', 'main')).toEqual([
      'pr',
      'list',
      '--head',
      'feat/x',
      '--base',
      'main',
      '--state',
      'all',
      '--json',
      'state',
    ]);
  });

  it('builds a glab query over every state for the source and target branches', () => {
    expect(buildClosedQuery('glab', 'feat/x', 'main')).toEqual([
      'mr',
      'list',
      '--all',
      '--source-branch',
      'feat/x',
      '--target-branch',
      'main',
      '-F',
      'json',
    ]);
  });
});

describe('parseClosedResult', () => {
  it('is true for a closed-unmerged PR (gh CLOSED)', () => {
    expect(parseClosedResult('[{"state":"CLOSED"}]')).toBe(true);
  });

  it('is false for a merged PR reported under gh --state closed (MERGED)', () => {
    // gh models merged as a kind of closed, so `--state closed` returns it too;
    // the parser MUST drop it.
    expect(parseClosedResult('[{"state":"MERGED"}]')).toBe(false);
  });

  it('is true for a closed MR (glab lowercase closed)', () => {
    expect(parseClosedResult('[{"state":"closed"}]')).toBe(true);
  });

  it('is false for a merged MR (glab lowercase merged)', () => {
    expect(parseClosedResult('[{"state":"merged"}]')).toBe(false);
  });

  it('is true when a mix of merged and closed entries is present', () => {
    expect(parseClosedResult('[{"state":"MERGED"},{"state":"CLOSED"}]')).toBe(
      true,
    );
  });

  it('is false when a still-open PR accompanies the closed one (gh OPEN)', () => {
    // The reopen/supersede workflow: PR #1 closed, PR #2 opened from the same
    // branch. The branch is alive — the closed PR is stale, not a death notice.
    expect(parseClosedResult('[{"state":"OPEN"},{"state":"CLOSED"}]')).toBe(
      false,
    );
  });

  it('is false when a still-open MR accompanies the closed one (glab opened)', () => {
    expect(parseClosedResult('[{"state":"opened"},{"state":"closed"}]')).toBe(
      false,
    );
  });

  it('is false when an open PR accompanies a merged and a closed one', () => {
    expect(
      parseClosedResult(
        '[{"state":"OPEN"},{"state":"MERGED"},{"state":"CLOSED"}]',
      ),
    ).toBe(false);
  });

  it('is false for an open PR alone', () => {
    expect(parseClosedResult('[{"state":"OPEN"}]')).toBe(false);
    expect(parseClosedResult('[{"state":"opened"}]')).toBe(false);
  });

  it('is false for an empty array', () => {
    expect(parseClosedResult('[]')).toBe(false);
  });

  it('is false for non-array or unparseable output', () => {
    expect(parseClosedResult('{"state":"CLOSED"}')).toBe(false);
    expect(parseClosedResult('not json')).toBe(false);
    expect(parseClosedResult('')).toBe(false);
  });
});

describe('parseMergedResult', () => {
  it('is true for a non-empty JSON array', () => {
    expect(parseMergedResult('[{"number":15}]')).toBe(true);
  });

  it('is false for an empty array', () => {
    expect(parseMergedResult('[]')).toBe(false);
  });

  it('is false for non-array or unparseable output', () => {
    expect(parseMergedResult('{"number":1}')).toBe(false);
    expect(parseMergedResult('not json')).toBe(false);
    expect(parseMergedResult('')).toBe(false);
  });
});

describe('hasMergedPullRequest', () => {
  const runner = (url: string, out: string): ForgeRunner => ({
    remoteUrl: () => url,
    query: () => out,
  });

  it('returns true when the forge reports a merged PR/MR', () => {
    expect(
      hasMergedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('git@git.chevro.fr:o/r.git', '[{"iid":15}]'),
      ),
    ).toBe(true);
  });

  it('returns false when the forge reports none', () => {
    expect(
      hasMergedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('git@github.com:o/r.git', '[]'),
      ),
    ).toBe(false);
  });

  it('routes the query through the tool chosen for the host', () => {
    let tool: string | undefined;
    const spy: ForgeRunner = {
      remoteUrl: () => 'git@github.com:o/r.git',
      query: (_repo, t) => {
        tool = t;
        return '[{"number":1}]';
      },
    };
    expect(hasMergedPullRequest('/repo', 'feat/x', 'main', 'origin', spy)).toBe(
      true,
    );
    expect(tool).toBe('gh');
  });

  it('filters the query by the base branch as the PR target', () => {
    // The caller does no ancestry check, so without this filter a branch merged
    // into `develop` would be reported as merged into `main`.
    let args: string[] | undefined;
    const spy: ForgeRunner = {
      remoteUrl: () => 'git@github.com:o/r.git',
      query: (_repo, _tool, a) => {
        args = a;
        return '[{"number":1}]';
      },
    };
    hasMergedPullRequest('/repo', 'feat/x', 'main', 'origin', spy);
    expect(args?.join(' ')).toContain('--base main');
  });

  it('fails closed (false) when resolving the remote throws', () => {
    const throwing: ForgeRunner = {
      remoteUrl: () => {
        throw new Error('no such remote');
      },
      query: () => '[{"number":1}]',
    };
    expect(
      hasMergedPullRequest('/repo', 'feat/x', 'main', 'origin', throwing),
    ).toBe(false);
  });

  it('fails closed (false) when the query (CLI) throws or times out', () => {
    const throwing: ForgeRunner = {
      remoteUrl: () => 'git@github.com:o/r.git',
      query: () => {
        throw new Error('gh: command not found');
      },
    };
    expect(
      hasMergedPullRequest('/repo', 'feat/x', 'main', 'origin', throwing),
    ).toBe(false);
  });

  it('fails closed (false) when the host is unparseable', () => {
    expect(
      hasMergedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('garbage', '[]'),
      ),
    ).toBe(false);
  });
});

describe('hasClosedPullRequest', () => {
  const runner = (url: string, out: string): ForgeRunner => ({
    remoteUrl: () => url,
    query: () => out,
  });

  it('returns true when the forge reports a closed-unmerged PR/MR', () => {
    expect(
      hasClosedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('git@git.chevro.fr:o/r.git', '[{"state":"closed"}]'),
      ),
    ).toBe(true);
  });

  it('returns false when the forge reports only a merged PR (gh --state all)', () => {
    expect(
      hasClosedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('git@github.com:o/r.git', '[{"state":"MERGED"}]'),
      ),
    ).toBe(false);
  });

  it('returns false when a closed PR is superseded by an open one on the same head', () => {
    // Regression: a stale closed PR must not read as "branch is dead" while a
    // newer PR from the same branch is still open.
    expect(
      hasClosedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner(
          'git@github.com:o/r.git',
          '[{"state":"OPEN"},{"state":"CLOSED"}]',
        ),
      ),
    ).toBe(false);
  });

  it('returns false when the forge reports none', () => {
    expect(
      hasClosedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('git@github.com:o/r.git', '[]'),
      ),
    ).toBe(false);
  });

  it('routes the query through the tool chosen for the host', () => {
    let tool: string | undefined;
    const spy: ForgeRunner = {
      remoteUrl: () => 'git@github.com:o/r.git',
      query: (_repo, t) => {
        tool = t;
        return '[{"state":"CLOSED"}]';
      },
    };
    expect(hasClosedPullRequest('/repo', 'feat/x', 'main', 'origin', spy)).toBe(
      true,
    );
    expect(tool).toBe('gh');
  });

  it('filters the query by the base branch as the PR target', () => {
    let args: string[] | undefined;
    const spy: ForgeRunner = {
      remoteUrl: () => 'git@github.com:o/r.git',
      query: (_repo, _tool, a) => {
        args = a;
        return '[{"state":"CLOSED"}]';
      },
    };
    hasClosedPullRequest('/repo', 'feat/x', 'main', 'origin', spy);
    expect(args?.join(' ')).toContain('--base main');
  });

  it('fails closed (false) when resolving the remote throws', () => {
    const throwing: ForgeRunner = {
      remoteUrl: () => {
        throw new Error('no such remote');
      },
      query: () => '[{"state":"CLOSED"}]',
    };
    expect(
      hasClosedPullRequest('/repo', 'feat/x', 'main', 'origin', throwing),
    ).toBe(false);
  });

  it('fails closed (false) when the query (CLI) throws or times out', () => {
    const throwing: ForgeRunner = {
      remoteUrl: () => 'git@github.com:o/r.git',
      query: () => {
        throw new Error('gh: command not found');
      },
    };
    expect(
      hasClosedPullRequest('/repo', 'feat/x', 'main', 'origin', throwing),
    ).toBe(false);
  });

  it('fails closed (false) when the host is unparseable', () => {
    expect(
      hasClosedPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('garbage', '[{"state":"CLOSED"}]'),
      ),
    ).toBe(false);
  });
});
