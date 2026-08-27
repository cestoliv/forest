import type { TodoistTask } from './todoist.js';

/**
 * A Todoist due date acts as a start date: the spawner leaves the task alone
 * until that moment passes. Date-only and floating datetimes are read in local
 * time, matching how Todoist shows them to you.
 */
const LOCAL_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

export function isDue(task: TodoistTask, now: Date = new Date()): boolean {
  const raw = task.due?.date;
  if (!raw) return true;
  const start = parseStart(raw);
  // An unreadable date must not strand a task forever, so treat it as due.
  if (!start) return true;
  return start.getTime() <= now.getTime();
}

function parseStart(raw: string): Date | null {
  const local = LOCAL_DATE.exec(raw);
  if (local) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = local;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }
  // What is left carries a zone (a trailing Z or an offset), so it names an
  // absolute instant. Anything unrecognised lands here too and parses to NaN.
  const absolute = new Date(raw);
  return Number.isNaN(absolute.getTime()) ? null : absolute;
}
