import type { Mode } from "../shared/caffeine.shared.ts";

/**
 * How long the machine stays awake after the last agent went quiet, and how long an
 * unanswered "are agents running?" keeps the previous answer alive. Three minutes cost
 * nothing; a Mac asleep under a working agent costs the task, so every doubt here
 * resolves towards staying awake.
 */
export const GRACE_MS = 3 * 60_000;

/** How often the server re-evaluates. Also the worst-case delay of a timer expiring. */
export const TICK_MS = 30_000;

export interface Stored {
  mode: Mode;
  /** RFC 3339 deadline in timer mode, empty otherwise. */
  until: string;
  /** Hold the display awake too, rather than letting it sleep under a waking system. */
  keepDisplay: boolean;
  /** The timer and On let the lid close too: lid mode for as long as they last. */
  lidClosed: boolean;
}

export interface Decision {
  active: boolean;
  /** The mode after this decision: a spent timer writes itself back as off. */
  stored: Stored;
  reason: string;
}

export function defaultStored(): Stored {
  return { mode: "off", until: "", keepDisplay: false, lidClosed: false };
}

export function untilForMinutes(nowMs: number, minutes: number): string {
  return new Date(nowMs + minutes * 60_000).toISOString();
}

/**
 * Moves the busy window. Running agents set it a full grace period ahead; an idle or
 * unknown answer leaves it alone, so the window closes on its own GRACE_MS after the
 * last confirmed activity — the same way for "nobody is running" and "nobody answered".
 */
export function nextBusyUntil(previousMs: number, running: number | null, nowMs: number): number {
  return running !== null && running > 0 ? nowMs + GRACE_MS : previousMs;
}

/** Off, but still remembering the display and lid switches, which outlive any one timer. */
function offKeeping(stored: Stored): Stored {
  return { ...defaultStored(), keepDisplay: stored.keepDisplay, lidClosed: stored.lidClosed };
}

export function decide(stored: Stored, nowMs: number, busyUntilMs: number): Decision {
  switch (stored.mode) {
    case "off":
      return { active: false, stored, reason: "off" };
    case "on":
      return { active: true, stored, reason: "on" };
    case "auto":
      return nowMs < busyUntilMs
        ? { active: true, stored, reason: "agents running or within grace" }
        : { active: false, stored, reason: "no agents running" };
    case "timer": {
      const deadline = Date.parse(stored.until);
      if (Number.isNaN(deadline)) {
        return { active: false, stored: offKeeping(stored), reason: "timer deadline unreadable; turned off" };
      }
      if (nowMs >= deadline) {
        return { active: false, stored: offKeeping(stored), reason: "timer expired; turned off" };
      }
      return { active: true, stored, reason: "timer running" };
    }
  }
}
