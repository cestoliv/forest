import { describe, expect, it, vi } from 'vitest';
import {
  type AgentSpawnerConfig,
  DEFAULT_CONFIG,
  type UsageConfig,
} from './config.js';
import { checkUsage, fetchUsage, type UsageSnapshot } from './usage.js';

const HOUR_MS = 3_600_000;

const base: AgentSpawnerConfig = {
  token: 't',
  pollIntervalSeconds: 600,
  branchPrefix: 'agent/',
  promptTemplate: 'go {{url}}',
  labels: { ready: '1', working: '2', error: '3' },
  maxWorktrees: 0,
  maxWorktreesPerRepo: {},
  usage: DEFAULT_CONFIG.usage,
  rules: [{ project: 'OVL', path: '/repos/mobile' }],
};

function withUsage(over: Partial<UsageConfig>): AgentSpawnerConfig {
  return { ...base, usage: { ...base.usage, ...over } };
}

/** A snapshot whose weekly reset sits `hours` from `now`. */
function snapshot(
  now: Date,
  hours: number,
  over: Partial<UsageSnapshot> = {},
): UsageSnapshot {
  return {
    weeklyPercent: 0,
    weeklyResetsAt: now.getTime() + hours * HOUR_MS,
    sessionPercent: 0,
    sessionResetsAt: null,
    ...over,
  };
}

// Noon keeps every case out of the night window unless it asks for it.
const noon = new Date(2026, 8, 1, 12, 0);

const NIGHT = DEFAULT_CONFIG.usage.night ?? {
  hours: [2, 6] as [number, number],
  dailyReservePercent: 4,
  sessionMaxPercent: 90,
  morningGuardHour: 8,
};

describe('checkUsage', () => {
  it('opens the gate when the week is barely touched', () => {
    const usage = snapshot(noon, 72, { weeklyPercent: 10 });
    expect(checkUsage(base, usage, noon)).toEqual({
      hold: null,
      capBonus: 0,
    });
  });

  it('holds when the reserve leaves no headroom', () => {
    // 4 days out, 13% a day reserved: 52% is spoken for, 50% is already spent.
    const usage = snapshot(noon, 96, { weeklyPercent: 50 });
    expect(checkUsage(base, usage, noon).hold).toMatch(/reserve/);
  });

  it('reserves less as the reset gets closer', () => {
    // Same 50% spent, one day out instead of four: reserve is 13%, so 37% is
    // available. This is the whole point of a decreasing reserve.
    const usage = snapshot(noon, 24, { weeklyPercent: 50 });
    expect(checkUsage(base, usage, noon).hold).toBeNull();
  });

  it('names the numbers it held on', () => {
    const usage = snapshot(noon, 96, { weeklyPercent: 50 });
    const hold = checkUsage(base, usage, noon).hold ?? '';
    expect(hold).toContain('50%');
    expect(hold).toContain('52%');
  });

  it('holds when the 5h window is too far gone', () => {
    const usage = snapshot(noon, 72, { weeklyPercent: 10, sessionPercent: 60 });
    expect(checkUsage(base, usage, noon).hold).toMatch(/5h window/);
  });

  it('opens below the 5h ceiling', () => {
    const usage = snapshot(noon, 72, { weeklyPercent: 10, sessionPercent: 49 });
    expect(checkUsage(base, usage, noon).hold).toBeNull();
  });

  it('reports the weekly reserve before the 5h window', () => {
    const usage = snapshot(noon, 96, { weeklyPercent: 50, sessionPercent: 99 });
    expect(checkUsage(base, usage, noon).hold).toMatch(/reserve/);
  });

  it('drops the reserve and the 5h ceiling before the reset', () => {
    // 4 hours out, so use it or lose it: 95% spent and a nearly full window
    // must not hold anything back.
    const usage = snapshot(noon, 4, { weeklyPercent: 95, sessionPercent: 99 });
    expect(checkUsage(base, usage, noon)).toEqual({ hold: null, capBonus: 2 });
  });

  it('holds before the reset once the weekly limit is spent', () => {
    const usage = snapshot(noon, 4, { weeklyPercent: 100 });
    const verdict = checkUsage(base, usage, noon);
    expect(verdict.hold).toMatch(/weekly limit/);
    expect(verdict.capBonus).toBe(0);
  });

  it('grants no cap bonus outside the pre-reset window', () => {
    const usage = snapshot(noon, 9, { weeklyPercent: 10 });
    expect(checkUsage(base, usage, noon).capBonus).toBe(0);
  });

  it('reserves less at night', () => {
    const night = new Date(2026, 8, 1, 3, 0);
    // 4 days out: 52% reserved by day, 16% by night.
    const usage = snapshot(night, 96, { weeklyPercent: 60 });
    expect(checkUsage(base, usage, night).hold).toBeNull();
    expect(checkUsage(withUsage({ night: null }), usage, night).hold).toMatch(
      /reserve/,
    );
  });

  it('raises the 5h ceiling at night', () => {
    const night = new Date(2026, 8, 1, 3, 0);
    const usage = snapshot(night, 96, { sessionPercent: 80 });
    expect(checkUsage(base, usage, night).hold).toBeNull();
    expect(checkUsage(withUsage({ night: null }), usage, night).hold).toMatch(
      /5h window/,
    );
  });

  it('reads a night window that wraps midnight', () => {
    const config = withUsage({
      night: { ...NIGHT, hours: [22, 4] },
    });
    const late = new Date(2026, 8, 1, 23, 0);
    const usage = snapshot(late, 96, { sessionPercent: 80 });
    expect(checkUsage(config, usage, late).hold).toBeNull();
  });

  it('holds at night when the 5h window would run past the morning guard', () => {
    const night = new Date(2026, 8, 1, 3, 0);
    const usage = snapshot(night, 96, {
      sessionResetsAt: new Date(2026, 8, 1, 8, 30).getTime(),
    });
    expect(checkUsage(base, usage, night).hold).toMatch(/morning guard/);
  });

  it('opens at night when the window closes before the morning guard', () => {
    const night = new Date(2026, 8, 1, 3, 0);
    const usage = snapshot(night, 96, {
      sessionResetsAt: new Date(2026, 8, 1, 7, 0).getTime(),
    });
    expect(checkUsage(base, usage, night).hold).toBeNull();
  });

  it('measures the guard against a fresh window when none is open', () => {
    // No window open, so dispatching now opens one for five hours: 02:00 is
    // clear of an 08:00 guard, 04:00 is not.
    const early = new Date(2026, 8, 1, 2, 0);
    const late = new Date(2026, 8, 1, 4, 0);
    expect(checkUsage(base, snapshot(early, 96), early).hold).toBeNull();
    expect(checkUsage(base, snapshot(late, 96), late).hold).toMatch(
      /morning guard/,
    );
  });

  it('measures the guard against a fresh window when the last one closed', () => {
    // A reset already behind us is a window that closed. Dispatching opens a
    // new one, which at 04:00 runs to 09:00, past an 08:00 guard.
    const late = new Date(2026, 8, 1, 4, 0);
    const usage = snapshot(late, 96, {
      sessionResetsAt: new Date(2026, 8, 1, 3, 30).getTime(),
    });
    expect(checkUsage(base, usage, late).hold).toMatch(/morning guard/);
  });

  it('leaves the morning guard to the night', () => {
    const usage = snapshot(noon, 96, {
      sessionResetsAt: new Date(2026, 8, 2, 9, 0).getTime(),
    });
    expect(checkUsage(base, usage, noon).hold).toBeNull();
  });

  it('reserves nothing when the reset instant is unknown', () => {
    // No horizon means no reserve to compute. The weekly ceiling and the 5h
    // window still hold.
    const unknown: UsageSnapshot = {
      weeklyPercent: 90,
      weeklyResetsAt: null,
      sessionPercent: 10,
      sessionResetsAt: null,
    };
    expect(checkUsage(base, unknown, noon)).toEqual({
      hold: null,
      capBonus: 0,
    });
    expect(
      checkUsage(base, { ...unknown, weeklyPercent: 100 }, noon).hold,
    ).toMatch(/weekly limit/);
    expect(
      checkUsage(base, { ...unknown, sessionPercent: 60 }, noon).hold,
    ).toMatch(/5h window/);
  });
});

describe('fetchUsage', () => {
  const payload = {
    five_hour: { utilization: 66, resets_at: '2026-09-01T17:10:00.000Z' },
    seven_day: { utilization: 30, resets_at: '2026-09-06T23:00:00.000Z' },
  };

  const ok = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  it('maps both windows onto a snapshot', async () => {
    const usage = await fetchUsage({
      fetchImpl: ok(payload),
      readToken: () => 'tok',
    });
    expect(usage).toEqual({
      weeklyPercent: 30,
      weeklyResetsAt: Date.parse('2026-09-06T23:00:00.000Z'),
      sessionPercent: 66,
      sessionResetsAt: Date.parse('2026-09-01T17:10:00.000Z'),
    });
  });

  it('sends the OAuth token the usage endpoint expects', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;
    await fetchUsage({ fetchImpl, readToken: () => 'tok' });
    const [url, init] = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
  });

  it('asks nothing without a token', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await fetchUsage({ fetchImpl, readToken: () => null })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads a refused request as unknown usage', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    expect(await fetchUsage({ fetchImpl, readToken: () => 't' })).toBeNull();
  });

  it('reads a failed request as unknown usage', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchUsage({ fetchImpl, readToken: () => 't' })).toBeNull();
  });

  it('reads a payload with no weekly window as unknown usage', async () => {
    const usage = await fetchUsage({
      fetchImpl: ok({ five_hour: { utilization: 10 } }),
      readToken: () => 't',
    });
    expect(usage).toBeNull();
  });

  it('reads a missing 5h window as an untouched window', async () => {
    const usage = await fetchUsage({
      fetchImpl: ok({ seven_day: { utilization: 12 } }),
      readToken: () => 't',
    });
    expect(usage).toEqual({
      weeklyPercent: 12,
      weeklyResetsAt: null,
      sessionPercent: 0,
      sessionResetsAt: null,
    });
  });
});
