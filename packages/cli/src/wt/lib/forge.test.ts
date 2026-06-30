// src/lib/forge.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildMergedQuery,
  type ForgeRunner,
  hasMergedPullRequest,
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
  it('builds a gh query filtered to merged PRs for the head branch', () => {
    expect(buildMergedQuery('gh', 'feat/x')).toEqual([
      'pr',
      'list',
      '--head',
      'feat/x',
      '--state',
      'merged',
      '--json',
      'number',
    ]);
  });

  it('builds a glab query filtered to merged MRs for the source branch', () => {
    expect(buildMergedQuery('glab', 'feat/x')).toEqual([
      'mr',
      'list',
      '--merged',
      '--source-branch',
      'feat/x',
      '-F',
      'json',
    ]);
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
    expect(hasMergedPullRequest('/repo', 'feat/x', 'origin', spy)).toBe(true);
    expect(tool).toBe('gh');
  });

  it('fails closed (false) when resolving the remote throws', () => {
    const throwing: ForgeRunner = {
      remoteUrl: () => {
        throw new Error('no such remote');
      },
      query: () => '[{"number":1}]',
    };
    expect(hasMergedPullRequest('/repo', 'feat/x', 'origin', throwing)).toBe(
      false,
    );
  });

  it('fails closed (false) when the query (CLI) throws or times out', () => {
    const throwing: ForgeRunner = {
      remoteUrl: () => 'git@github.com:o/r.git',
      query: () => {
        throw new Error('gh: command not found');
      },
    };
    expect(hasMergedPullRequest('/repo', 'feat/x', 'origin', throwing)).toBe(
      false,
    );
  });

  it('fails closed (false) when the host is unparseable', () => {
    expect(
      hasMergedPullRequest(
        '/repo',
        'feat/x',
        'origin',
        runner('garbage', '[]'),
      ),
    ).toBe(false);
  });
});
