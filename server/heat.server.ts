import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThermalStatus } from "../shared/caffeine.shared.ts";
import { toEvent } from "./emergency.server.ts";
import type { HeatSensors, Reading } from "./sensors.server.ts";
import {
  DEFAULT_THERMAL,
  type LatchRecord,
  type StoredThermal,
  type ThermalView,
  type Trip,
  coolSince,
  createThermalEvaluator,
  formatGuardConf,
  formatLatch,
  normalizeThermal,
  parseLatch,
} from "./thermal.ts";

/**
 * The heat guard as the plugin runs it, every 15 s: read, decide (server/thermal.ts), act
 * (server/emergency.server.ts), and keep acting while the latch holds — lid mode off, sleep
 * allowed, Caffeine's own hold suspended with the lid closed, back to sleep after a wake —
 * until the Mac has cooled down and somebody turns lid mode on again. The LaunchAgent guard
 * runs the same rules from sh, so neither depends on the other being alive.
 */

export const HEAT_TICK_MS = 15_000;
/** At most one re-sleep a minute while latched, so a wake that is needed is not fought. */
export const RESLEEP_MS = 60_000;
/** A lock older than this was left by a crash. */
const STALE_LOCK_MS = 5 * 60_000;

export interface HeatFiles {
  latch: string;
  lock: string;
  dryRun: string;
  conf: string;
}

export interface HeatDeps {
  sensors: HeatSensors;
  /** Lid mode is on (sleep switched off system-wide): only then do the triggers act. */
  armed(): boolean;
  files: HeatFiles;
  /** The emergency sequence, with the dry-run decided here. */
  emergency(trip: Trip, dryRun: boolean): Promise<LatchRecord | null>;
  /** Lid mode off again, for a latch that finds it back on. */
  endForHeat(): Promise<boolean>;
  /** `pmset sleepnow`, for a latched Mac woken with the lid closed. */
  resleep(): Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Heat {
  tick(): Promise<void>;
  status(): ThermalStatus;
  /** The host's preferences, whenever they change. */
  setStored(stored: StoredThermal): void;
  /** Whether Caffeine's own hold must stay off: a real latch, and the lid not known to be open. */
  holdSuspended(): boolean;
  /** Before lid mode comes on: "cooling" while a real latch has not cooled down, else the
   *  latch is let go and "ok". */
  gate(): Promise<"ok" | "cooling">;
  /** Whether a real latch holds right now (read from the file, so the guard's counts too). */
  latched(): boolean;
  dismiss(): Promise<void>;
}

let writes = 0;
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A name per write: two writes of the same file can overlap (a settings change and a tick).
  writes += 1;
  const temp = `${path}.${process.pid}.${writes}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

export function fileLatch(path: string) {
  return {
    read: async (): Promise<LatchRecord | null> => parseLatch(await readFile(path, "utf8").catch(() => "")),
    readSync: (): LatchRecord | null => {
      try {
        return parseLatch(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    },
    write: (record: LatchRecord) => writeAtomic(path, formatLatch(record)),
    remove: () => rm(path, { force: true }),
  };
}

/** The lock shared with the sh guard: a directory, since mkdir is atomic in both. */
export function fileLock(path: string, now: () => number = Date.now) {
  return {
    async take(): Promise<boolean> {
      try {
        await mkdir(path);
        return true;
      } catch {
        const age = await stat(path).then((info) => now() - info.mtimeMs, () => 0);
        if (age < STALE_LOCK_MS) return false;
        await rmdir(path).catch(() => undefined);
        return mkdir(path).then(() => true, () => false);
      }
    },
    release: () => rmdir(path).catch(() => undefined),
  };
}

export function createHeat(deps: HeatDeps): Heat {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const latchFile = fileLatch(deps.files.latch);
  const evaluator = createThermalEvaluator();

  let stored: StoredThermal = {};
  let settings = DEFAULT_THERMAL;
  let reading: Reading | null = null;
  let view: ThermalView = { state: "normal", pendingReason: "", firesAt: null };
  let record: LatchRecord | null = null;
  let dryRun = false;
  let coolStart: number | null = null;
  /** The last reading that was still cool: the cool-down is measured in readings, not in
   *  time since, so a Mac that warmed up between two looks is not let off early. */
  let coolLast: number | null = null;
  let lastResleep = 0;
  let conf = "";
  let running = false;
  /** An emergency in progress: the hold stays off whatever the lid says, or a retry would
   *  run under a fresh caffeinate. */
  let acting = false;

  const real = (latch: LatchRecord | null) => (latch && !latch.dryRun ? latch : null);
  const cooled = () => coolStart !== null && coolLast !== null && coolLast - coolStart >= settings.cooldownMin * 60_000;

  async function writeConf(): Promise<void> {
    const next = formatGuardConf(settings, deps.sensors.helper());
    if (next === conf) return;
    await writeAtomic(deps.files.conf, next);
    conf = next;
  }

  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        const at = now();
        reading = await deps.sensors.read();
        settings = normalizeThermal(stored, reading.fans);
        await writeConf().catch((failure) => log(`caffeine: heat guard settings not written: ${String(failure)}`));
        // Simulated readings are never acted on, whatever the switch says.
        dryRun = reading.simulated || existsSync(deps.files.dryRun);
        record = await latchFile.read();
        // A simulation may pretend lid mode is on; it is a dry run either way (above).
        const armed = reading.simulated && reading.armed !== undefined ? reading.armed : deps.armed();
        const sample = { at, pressure: reading.pressure, batteryC: reading.batteryC, fans: reading.fans, lidClosed: reading.lidClosed, armed };

        const latch = real(record);
        if (latch) {
          evaluator.reset();
          coolStart = coolSince(coolStart, sample);
          coolLast = coolStart === null ? null : at;
          if (dryRun) return;
          // Lid mode back on under a latch (a guard that could not switch it off, a hand): off.
          if (deps.armed()) await deps.endForHeat();
          if (reading.lidClosed === true && at - lastResleep >= RESLEEP_MS) {
            lastResleep = at;
            log("caffeine: heat guard: latched and the lid is closed, back to sleep");
            await deps.resleep();
          }
          return;
        }
        coolStart = null;
        coolLast = null;
        const outcome = evaluator.observe(sample, settings);
        view = outcome.view;
        // A dry-run record holds back the next one until it is dismissed: one line per spell.
        if (outcome.trip && !record) {
          acting = !dryRun;
          try {
            record = (await deps.emergency(outcome.trip, dryRun)) ?? (await latchFile.read());
          } finally {
            acting = false;
          }
          evaluator.reset();
        }
      } finally {
        running = false;
      }
    },

    status() {
      const latch = real(record);
      const coolAt = latch && coolStart !== null ? new Date(coolStart + settings.cooldownMin * 60_000).toISOString() : "";
      return {
        pressure: reading?.pressure ?? null,
        batteryC: reading?.batteryC ?? null,
        cpuC: reading?.cpuC ?? null,
        fans: reading?.fans ?? null,
        sensors: reading?.sensors ?? "",
        lidClosed: reading?.lidClosed ?? null,
        armed: reading?.simulated && reading.armed !== undefined ? reading.armed : deps.armed(),
        dryRun,
        simulated: reading?.simulated ?? false,
        state: latch ? "latched" : view.state,
        pendingReason: latch ? "" : view.pendingReason,
        firesAt: !latch && view.firesAt !== null ? new Date(view.firesAt).toISOString() : "",
        latch: latch ? toEvent(latch) : null,
        cool: latch ? cooled() : false,
        coolAt,
        event: record && !record.dismissed ? toEvent(record) : null,
        settings,
      };
    },

    setStored(next) {
      stored = next;
      settings = normalizeThermal(stored, reading?.fans ?? null);
      void writeConf().catch((failure) => log(`caffeine: heat guard settings not written: ${String(failure)}`));
    },

    holdSuspended() {
      if (acting) return true;
      const latch = real(latchFile.readSync());
      return latch !== null && !dryRun && reading?.lidClosed !== false;
    },

    latched: () => real(latchFile.readSync()) !== null,

    async gate() {
      const latch = real(await latchFile.read());
      if (!latch) return "ok";
      if (!cooled()) return "cooling";
      await latchFile.remove();
      record = null;
      coolStart = null;
      coolLast = null;
      log("caffeine: heat guard: cooled down, lid mode allowed again");
      return "ok";
    },

    async dismiss() {
      const current = await latchFile.read();
      if (!current) return;
      // A dry run blocks nothing, so its record can simply go; a real latch stays until cool.
      if (current.dryRun) await latchFile.remove();
      else await latchFile.write({ ...current, dismissed: true });
      record = await latchFile.read();
    },
  };
}
