import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSpawnerConfig, UsageRegime } from './config.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const HOUR_MS = 3_600_000;
const SESSION_WINDOW_HOURS = 5;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * What the two rate-limit windows of a Claude subscription look like right now.
 * `weeklyPercent` and `sessionPercent` are percentages of the real cap, so the
 * daemon never has to know how many tokens a plan grants.
 *
 * A null reset instant means the API reported none: the window exists, but its
 * horizon is unknown.
 */
export interface UsageSnapshot {
  weeklyPercent: number;
  weeklyResetsAt: number | null;
  sessionPercent: number;
  sessionResetsAt: number | null;
}

/**
 * `hold` is why no task may be dispatched this tick, or null when the gate is
 * open. `capBonus` is the extra worktree slots the pre-reset window grants, on
 * top of both configured caps: what the weekly limit still holds is lost at the
 * reset, so the last hours of the week may run over the steady-state cap.
 */
export interface UsageVerdict {
  hold: string | null;
  capBonus: number;
}

const OPEN: UsageVerdict = { hold: null, capBonus: 0 };

/**
 * Decide whether the weekly and 5h windows leave room for one more agent.
 *
 * The weekly test is a decreasing reserve: `dailyReservePercent` protects one
 * day of your own interactive work, times the days left before the reset. Early
 * in the week the reserve protects several such days and the daemon is
 * conservative. The evening before the reset it protects almost nothing and the
 * daemon is aggressive, with no ramp-up curve to tune.
 *
 * `now` is the caller's clock, so the night window and the morning guard read
 * local time. Callers only ask when `config.usage.enabled` is set.
 */
export function checkUsage(
  config: AgentSpawnerConfig,
  usage: UsageSnapshot,
  now: Date,
): UsageVerdict {
  const settings = config.usage;
  const hoursToReset =
    usage.weeklyResetsAt === null
      ? null
      : (usage.weeklyResetsAt - now.getTime()) / HOUR_MS;

  if (hoursToReset !== null && hoursToReset <= settings.preResetHours) {
    // Use it or lose it: no reserve, no window ceiling, and room for a few
    // worktrees over the cap.
    if (usage.weeklyPercent >= 100) {
      return {
        hold: `weekly limit spent (${pct(usage.weeklyPercent)})`,
        capBonus: 0,
      };
    }
    return { hold: null, capBonus: settings.preResetBonusWorktrees };
  }

  const night = settings.night;
  const isNight = night !== null && inWindow(night.hours, now);
  const regime: UsageRegime = isNight ? night : settings;

  // An unknown horizon reserves nothing rather than a whole week, so a payload
  // without `resets_at` cannot wedge the daemon behind a reserve it cannot
  // measure.
  const reserve =
    hoursToReset === null
      ? 0
      : (regime.dailyReservePercent * hoursToReset) / 24;
  const available = 100 - usage.weeklyPercent - reserve;
  if (available <= 0) {
    return {
      hold:
        reserve === 0
          ? `weekly limit spent (${pct(usage.weeklyPercent)})`
          : `weekly reserve holds (${pct(usage.weeklyPercent)} spent, ${pct(reserve)} reserved for the ${fmt(hoursToReset ?? 0)}h to the reset)`,
      capBonus: 0,
    };
  }

  if (usage.sessionPercent >= regime.sessionMaxPercent) {
    return {
      hold: `5h window at ${pct(usage.sessionPercent)} (ceiling ${pct(regime.sessionMaxPercent)})`,
      capBonus: 0,
    };
  }

  if (isNight) {
    // Without the guard a night agent would still own the 5h window you wake
    // up into. A window is open only while its reset is still ahead: a reset
    // already behind us describes a window that closed, and dispatching then
    // opens a fresh one for the next five hours.
    const openUntil = usage.sessionResetsAt ?? 0;
    const windowEnds =
      openUntil > now.getTime()
        ? openUntil
        : now.getTime() + SESSION_WINDOW_HOURS * HOUR_MS;
    const guard = nextHourInstant(now, night.morningGuardHour);
    if (windowEnds > guard) {
      return {
        hold: `5h window would run past the morning guard (${new Date(windowEnds).toLocaleTimeString()} > ${new Date(guard).toLocaleTimeString()})`,
        capBonus: 0,
      };
    }
  }

  return OPEN;
}

export interface UsageFetchDeps {
  fetchImpl?: typeof fetch;
  readToken?: () => string | null;
  timeoutMs?: number;
}

interface UsageWindowPayload {
  utilization?: number;
  resets_at?: string | null;
}

/**
 * Read both windows from Claude's own quota endpoint, the one Claude Code's
 * `/usage` reads. Returns null when the usage cannot be measured (no
 * credentials, a refused or failed request, a payload with no weekly window),
 * which callers treat as an open gate: an expired token must not freeze the
 * daemon for good.
 */
export async function fetchUsage(
  deps: UsageFetchDeps = {},
): Promise<UsageSnapshot | null> {
  const token = (deps.readToken ?? readClaudeToken)();
  if (!token) return null;

  try {
    const response = await (deps.fetchImpl ?? fetch)(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      five_hour?: UsageWindowPayload;
      seven_day?: UsageWindowPayload;
    };
    const weeklyPercent = readPercent(data?.seven_day);
    if (weeklyPercent === null) return null;

    return {
      weeklyPercent,
      weeklyResetsAt: readInstant(data?.seven_day?.resets_at),
      // A window with no usage yet is reported as absent by some plans, and an
      // untouched window holds nothing back.
      sessionPercent: readPercent(data?.five_hour) ?? 0,
      sessionResetsAt: readInstant(data?.five_hour?.resets_at),
    };
  } catch {
    return null;
  }
}

/**
 * The OAuth access token Claude Code stores, from the macOS Keychain first and
 * `~/.claude/.credentials.json` second, the two places Claude Code writes it.
 * `expiresAt` is deliberately ignored: the usage endpoint is the authority on
 * whether a token still works.
 */
export function readClaudeToken(): string | null {
  return readFromKeychain() ?? readFromCredentialsFile();
}

function readFromKeychain(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return parseToken(
      execFileSync(
        'security',
        [
          'find-generic-password',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          os.userInfo().username,
          '-w',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 3_000 },
      ),
    );
  } catch {
    return null;
  }
}

function readFromCredentialsFile(): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  try {
    return parseToken(
      readFileSync(
        path.join(
          dir || path.join(os.homedir(), '.claude'),
          '.credentials.json',
        ),
        'utf8',
      ),
    );
  } catch {
    return null;
  }
}

function parseToken(raw: string): string | null {
  try {
    const token = (
      JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }
    )?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.trim() !== '' ? token : null;
  } catch {
    return null;
  }
}

function readPercent(window: UsageWindowPayload | undefined): number | null {
  const value = window?.utilization;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function readInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whether `now`'s local time falls in `[start, end)`, in hours. A window whose
 * end is at or before its start wraps midnight (`[22, 4]` is 22:00 to 04:00).
 */
function inWindow(hours: readonly [number, number], now: Date): boolean {
  const [start, end] = hours;
  const hour = now.getHours() + now.getMinutes() / 60;
  return start <= end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

/** The next local time `hour` strikes, today or tomorrow. */
function nextHourInstant(now: Date, hour: number): number {
  const at = new Date(now);
  at.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function pct(value: number): string {
  return `${fmt(value)}%`;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
