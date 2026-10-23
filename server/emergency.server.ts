import type { ThermalEvent } from "../shared/caffeine.shared.ts";
import type { LatchRecord, Trip } from "./thermal.ts";

/**
 * The one way the heat guard puts the Mac to sleep, in an order that matters:
 *
 * 0. A dry run (the switch file, or simulated readings) records what it would have done and
 *    stops there.
 * 1. The lock: the plugin and the LaunchAgent guard can both see the same heat, and only one
 *    of them goes on.
 * 2. The latch is written before anything is done, so a crash halfway still leaves lid mode
 *    locked out and the page able to say why.
 * 3. Sleep switched back on (`sudo -n pmset -a disablesleep 0`) and confirmed with `pmset -g`:
 *    while it reads 1, the kernel refuses every sleep, its own thermal emergency included.
 * 4. Caffeine's own caffeinate goes, and stays gone while the latch holds; nobody else's is
 *    touched (`-s` holds sleep off on the charger, and turns `sleepnow` into a DarkWake).
 * 5. Whoever else holds PreventSystemSleep is written down: only that can still stop it, and a
 *    non-root process cannot take another's assertion away.
 * 6. `pmset sleepnow`, then a wait: a process does not run while the Mac sleeps, so the wall
 *    clock running well ahead of the monotonic one is the sleep, seen from inside.
 * 7. Up to three tries; the outcome goes into the latch either way.
 */

/** How long to wait before looking whether the sleep happened. */
export const VERIFY_MS = 20_000;
/** The wall clock ahead of the monotonic one by at least this means the Mac slept. */
export const SLEPT_GAP_MS = 15_000;
export const ATTEMPTS = 3;

export interface EmergencyDeps {
  dryRun(): boolean;
  /** Takes the lock shared with the sh guard; false when somebody already has it. */
  lock(): Promise<boolean>;
  unlock(): Promise<void>;
  writeLatch(record: LatchRecord): Promise<void>;
  /** `sudo -n pmset -a disablesleep 0`, confirmed by `pmset -g`; true once it reads 0. */
  allowSleep(): Promise<boolean>;
  /** Ends Caffeine's own caffeinate; the latch keeps it from coming back. */
  releaseHold(): void;
  /** Other processes holding PreventSystemSleep, by name. */
  holders(): Promise<string[]>;
  sleepNow(): Promise<void>;
  /** Waits `ms` on the monotonic clock and says how far the wall clock ran ahead meanwhile. */
  waitGap(ms: number): Promise<number>;
  now(): number;
  log(line: string): void;
}

export function toEvent(record: LatchRecord): ThermalEvent {
  return {
    at: new Date(record.at * 1000).toISOString(),
    reason: record.reason,
    detail: record.detail,
    dryRun: record.dryRun,
    slept: record.slept,
    holders: record.holders,
    by: record.by,
  };
}

export async function emergencySleep(trip: Trip, deps: EmergencyDeps): Promise<LatchRecord | null> {
  const record: LatchRecord = {
    at: Math.round(deps.now() / 1000),
    reason: trip.reason,
    detail: trip.detail,
    dryRun: deps.dryRun(),
    slept: null,
    holders: [],
    by: "plugin",
    dismissed: false,
  };
  if (record.dryRun) {
    await deps.writeLatch(record);
    deps.log(`caffeine: heat guard, dry run: would put the Mac to sleep (${trip.reason}: ${trip.detail})`);
    return record;
  }
  if (!(await deps.lock())) {
    deps.log(`caffeine: heat guard: ${trip.reason} seen, the LaunchAgent guard is already on it`);
    return null;
  }
  try {
    await deps.writeLatch(record);
    deps.log(`caffeine: heat guard: putting the Mac to sleep (${trip.reason}: ${trip.detail})`);
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (!(await deps.allowSleep())) deps.log("caffeine: heat guard: sleep could not be switched back on (SleepDisabled is still 1)");
      deps.releaseHold();
      const holders = await deps.holders();
      await deps.sleepNow();
      const gap = await deps.waitGap(VERIFY_MS);
      if (gap >= SLEPT_GAP_MS) {
        record.slept = true;
        record.holders = [];
        deps.log(`caffeine: heat guard: the Mac slept (${Math.round(gap / 1000)} s)`);
        break;
      }
      record.slept = false;
      record.holders = holders;
      deps.log(`caffeine: heat guard: sleep did not take (try ${attempt} of ${ATTEMPTS})${holders.length ? `, held by ${holders.join(", ")}` : ""}`);
    }
    await deps.writeLatch(record);
    return record;
  } finally {
    await deps.unlock();
  }
}

/** `pmset -g assertions`: the processes with a PreventSystemSleep, except the ones given. */
export function parseSystemSleepHolders(output: string, exceptPids: readonly number[] = []): string[] {
  const holders = new Set<string>();
  for (const match of output.matchAll(/^\s*pid (\d+)\(([^)]+)\):.*\bPreventSystemSleep named:/gm)) {
    if (!exceptPids.includes(Number(match[1]))) holders.add(match[2]);
  }
  return [...holders];
}
