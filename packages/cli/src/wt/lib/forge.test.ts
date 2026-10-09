// src/lib/forge.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildOpenQuery,
  buildPullRequestQuery,
  type ForgeRunner,
  fetchPullRequests,
  findOpenPullRequest,
  parseOpenResult,
  parsePullRequests,
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

describe('buildPullRequestQuery', () => {
  it('asks gh for every state, filtered by head and base, with the card fields', () => {
    expect(buildPullRequestQuery('gh', 'feat/x', 'main')).toEqual([
      'pr',
      'list',
      '--head',
      'feat/x',
      '--base',
      'main',
      '--state',
      'all',
      '--json',
      'number,title,url,state,mergedAt,closedAt',
    ]);
  });

  it('asks glab for every state, filtered by source and target', () => {
    expect(buildPullRequestQuery('glab', 'feat/x', 'main')).toEqual([
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

describe('parsePullRequests', () => {
  const gh = (state: string, extra: Record<string, unknown> = {}) => ({
    number: 12,
    title: 'feat: x',
    url: 'https://github.com/o/r/pull/12',
    state,
    ...extra,
  });
  const glab = (state: string, extra: Record<string, unknown> = {}) => ({
    iid: 7,
    title: 'feat: y',
    web_url: 'https://gitlab.com/o/r/-/merge_requests/7',
    state,
    ...extra,
  });
  const parse = (prs: unknown[]) => parsePullRequests(JSON.stringify(prs));

  it('reads a merged gh PR, with its card data', () => {
    expect(parse([gh('MERGED', { mergedAt: '2026-10-01T00:00:00Z' })])).toEqual(
      {
        merged: true,
        closed: false,
        latest: {
          number: 12,
          title: 'feat: x',
          url: 'https://github.com/o/r/pull/12',
          state: 'merged',
          endedAt: '2026-10-01T00:00:00Z',
        },
      },
    );
  });

  it('reads a merged glab MR (iid, web_url, merged_at)', () => {
    const result = parse([glab('merged', { merged_at: '2026-10-02' })]);
    expect(result?.merged).toBe(true);
    expect(result?.closed).toBe(false);
    expect(result?.latest).toMatchObject({
      number: 7,
      url: 'https://gitlab.com/o/r/-/merge_requests/7',
      endedAt: '2026-10-02',
    });
  });

  it('reads a closed-unmerged PR/MR as closed, not merged', () => {
    expect(parse([gh('CLOSED')])).toMatchObject({
      merged: false,
      closed: true,
    });
    expect(parse([glab('closed')])).toMatchObject({
      merged: false,
      closed: true,
    });
  });

  it('lets an open PR/MR on the same head veto closed', () => {
    // Regression: a stale closed PR must not read as "branch is dead" while a
    // newer PR from the same branch is still open.
    expect(parse([gh('OPEN'), gh('CLOSED')])?.closed).toBe(false);
    expect(parse([glab('opened'), glab('closed')])?.closed).toBe(false);
  });

  it('reads mixed results: merged wins, closed needs a CLOSED besides MERGED', () => {
    expect(parse([gh('MERGED'), gh('CLOSED')])).toMatchObject({
      merged: true,
      closed: true,
    });
    // gh models merged as a kind of closed: MERGED alone is not closed.
    expect(parse([gh('MERGED')])?.closed).toBe(false);
  });

  it('shows the first (newest) entry as latest', () => {
    expect(
      parse([gh('OPEN', { number: 2 }), gh('CLOSED', { number: 1 })])?.latest
        ?.number,
    ).toBe(2);
  });

  it('reads an empty list as no signal and no latest', () => {
    expect(parse([])).toEqual({
      merged: false,
      closed: false,
      latest: undefined,
    });
  });

  it('returns null for unparseable or non-array output', () => {
    expect(parsePullRequests('not json')).toBeNull();
    expect(parsePullRequests('')).toBeNull();
    expect(parsePullRequests('{"state":"CLOSED"}')).toBeNull();
  });
});

describe('fetchPullRequests', () => {
  const runner = (url: string, out: string): ForgeRunner => ({
    remoteUrl: async () => url,
    query: async () => out,
  });

  it('parses the forge answer', async () => {
    const result = await fetchPullRequests(
      '/repo',
      'feat/x',
      'main',
      'origin',
      runner('git@git.chevro.fr:o/r.git', '[{"iid":15,"state":"merged"}]'),
    );
    expect(result?.merged).toBe(true);
  });

  it('routes the query through the tool for the host, filtered by base', async () => {
    let tool: string | undefined;
    let args: string[] | undefined;
    const spy: ForgeRunner = {
      remoteUrl: async () => 'git@github.com:o/r.git',
      query: async (_repo, t, a) => {
        tool = t;
        args = a;
        return '[]';
      },
    };
    await fetchPullRequests('/repo', 'feat/x', 'main', 'origin', spy);
    expect(tool).toBe('gh');
    // The caller does no ancestry check, so without this filter a branch merged
    // into `develop` would be reported as merged into `main`.
    expect(args?.join(' ')).toContain('--base main');
  });

  it('fails closed (null) when resolving the remote throws', async () => {
    const throwing: ForgeRunner = {
      remoteUrl: async () => {
        throw new Error('no such remote');
      },
      query: async () => '[{"state":"MERGED"}]',
    };
    expect(
      await fetchPullRequests('/repo', 'feat/x', 'main', 'origin', throwing),
    ).toBeNull();
  });

  it('fails closed (null) when the CLI is missing or times out', async () => {
    const throwing: ForgeRunner = {
      remoteUrl: async () => 'git@github.com:o/r.git',
      query: async () => {
        throw new Error('gh: command not found');
      },
    };
    expect(
      await fetchPullRequests('/repo', 'feat/x', 'main', 'origin', throwing),
    ).toBeNull();
  });

  it('fails closed (null) when the host is unparseable', async () => {
    expect(
      await fetchPullRequests(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('garbage', '[{"state":"MERGED"}]'),
      ),
    ).toBeNull();
  });
});

describe('findOpenPullRequest', () => {
  const runner = (url: string, out: string): ForgeRunner => ({
    remoteUrl: async () => url,
    query: async () => out,
  });

  it('asks gh and glab for open PRs/MRs into the base only', () => {
    expect(buildOpenQuery('gh', 'feat/x', 'main')).toEqual([
      'pr',
      'list',
      '--head',
      'feat/x',
      '--base',
      'main',
      '--state',
      'open',
      '--json',
      'number',
    ]);
    expect(buildOpenQuery('glab', 'feat/x', 'main')).toContain(
      '--target-branch',
    );
  });

  it('reads the gh number and the glab iid', () => {
    expect(parseOpenResult('[{"number":12}]')).toBe(12);
    expect(parseOpenResult('[{"iid":7,"id":9001}]')).toBe(7);
    expect(parseOpenResult('[]')).toBeUndefined();
    expect(parseOpenResult('nope')).toBeUndefined();
  });

  it('returns the open PR number, or undefined when the forge call fails', async () => {
    expect(
      await findOpenPullRequest(
        '/repo',
        'feat/x',
        'main',
        'origin',
        runner('git@github.com:o/r.git', '[{"number":42}]'),
      ),
    ).toBe(42);
    expect(
      await findOpenPullRequest('/repo', 'feat/x', 'main', 'origin', {
        remoteUrl: async () => 'git@github.com:o/r.git',
        query: async () => {
          throw new Error('offline');
        },
      }),
    ).toBeUndefined();
  });
});
