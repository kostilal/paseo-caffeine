import { type FanReading, THERMAL_LIMITS, type ThermalReason, type ThermalSettings } from "../shared/caffeine.shared.ts";

/**
 * The heat guard of lid mode, as pure logic: readings and settings in, what the page shows
 * and whether the Mac has to go to sleep out. Nothing here touches the system; the server
 * (server/heat.server.ts) and the LaunchAgent guard (lid.server.ts, the same rules in sh)
 * read the sensors and act.
 *
 * Why lid mode only: `pmset disablesleep 1` is checked by the kernel before its own
 * thermal-emergency sleep (xnu `checkSystemSleepAllowed`), so lid mode switches off macOS's
 * way out of a hot bag, and Caffeine has to supply one. Without lid mode a closed lid sleeps
 * the Mac anyway, and the kernel's emergency sleep gets past caffeinate's assertions.
 *
 * Three triggers are fixed, one is the user's:
 * - thermal pressure, macOS's own verdict over all its sensors (`com.apple.system.
 *   thermalpressurelevel`: 0 nominal … 4 sleeping): trapping and above at once, heavy (or
 *   moderate, if picked) once it has held for the delay;
 * - the battery at 45 °C two readings in a row — Apple's upper storage temperature for a
 *   MacBook Pro and the usual Li-ion charging limit, read the same way on every Mac; fixed;
 * - no readings at all for 90 s with the lid closed: a blind Mac in a bag is the case this
 *   is for;
 * - the fans, with the lid closed: any fan at the user's share of its own maximum for the
 *   user's delay. Fans stay at their floor in a bag (a closed MacBook at 63 °C measured with
 *   both fans at minimum), so this one is for a Mac working flat out, not a substitute.
 */

/** Fixed, not a setting: changing it needs its own decision. */
export const BATTERY_LIMIT_C = THERMAL_LIMITS.batteryLimitC;
/** From here the page says it is getting warm. */
export const BATTERY_WARM_C = THERMAL_LIMITS.batteryWarmC;
/** Cool enough to let lid mode back on, once it has stayed there for the cool-down. */
export const BATTERY_COOL_C = THERMAL_LIMITS.batteryCoolC;
/** Readings at or over the limit, in a row. */
export const BATTERY_READINGS = 2;
/** Neither pressure nor battery readable, with the lid closed, for this long. */
export const BLIND_MS = THERMAL_LIMITS.blindS * 1000;
/** Trapping (3) and sleeping (4) put the Mac to sleep without waiting. */
export const PRESSURE_AT_ONCE = 3;
/** With "moderate" picked, heavy still fires within this. */
export const HEAVY_CAP_S = 60;
export const HEAVY_DELAYS_S = THERMAL_LIMITS.heavyDelaysS;
export const MODERATE_DELAYS_S = THERMAL_LIMITS.moderateDelaysS;
export const COOLDOWNS_MIN = THERMAL_LIMITS.cooldownsMin;
export const FAN_DELAYS_S = THERMAL_LIMITS.fanDelaysS;
export const FAN_MAX_PCT = THERMAL_LIMITS.fanMaxPct;
export const FAN_STEP_PCT = THERMAL_LIMITS.fanStepPct;
/** A fan run ends only once every fan is this far below the threshold. */
export const FAN_REARM_PCT = 10;
export const FAN_DEFAULT_PCT = THERMAL_LIMITS.fanDefaultPct;
/** The lowest threshold when the fans' own floor is not known. */
export const FAN_FLOOR_PCT = 40;

export const DEFAULT_THERMAL: ThermalSettings = {
  pressure: "heavy",
  delayS: 60,
  cooldownMin: 5,
  fanPct: FAN_DEFAULT_PCT,
  fanDelayS: 60,
  fanMinPct: FAN_FLOOR_PCT,
};

const oneOf = (allowed: readonly number[], value: unknown): value is number =>
  typeof value === "number" && allowed.includes(value);

/**
 * The lowest fan threshold this machine allows: 10 points above the highest share any fan
 * idles at when it spins, on the 5 % grid. On 2317 / 7826 rpm that is 40 %. A threshold at
 * the floor would fire as soon as the fans turned.
 */
export function fanMinPct(fans: readonly FanReading[] | null): number {
  const floors = (fans ?? []).filter((fan) => fan.max > 0).map((fan) => (fan.min / fan.max) * 100);
  if (floors.length === 0) return FAN_FLOOR_PCT;
  const lowest = Math.ceil((Math.max(...floors) + FAN_REARM_PCT) / FAN_STEP_PCT) * FAN_STEP_PCT;
  return Math.min(FAN_MAX_PCT, Math.max(FAN_STEP_PCT, lowest));
}

/** The settings as stored by the host (any shape) → the settings the guard applies. */
export interface StoredThermal {
  thermalPressure?: unknown;
  thermalDelayS?: unknown;
  thermalCooldownMin?: unknown;
  fanPct?: unknown;
  fanDelayS?: unknown;
}

/**
 * Lands whatever is stored on something the guard can apply: a delay that does not belong to
 * the picked level falls back to that level's default, the fan threshold is put on the 5 %
 * grid between this machine's floor and 95 %, and anything unreadable takes the default.
 * Nothing here can switch the guard off.
 */
export function normalizeThermal(stored: StoredThermal, fans: readonly FanReading[] | null = null): ThermalSettings {
  const pressure = stored.thermalPressure === "moderate" ? "moderate" : "heavy";
  const delays = pressure === "moderate" ? MODERATE_DELAYS_S : HEAVY_DELAYS_S;
  const delayS = oneOf(delays, stored.thermalDelayS) ? stored.thermalDelayS : pressure === "moderate" ? 300 : 60;
  const cooldownMin = oneOf(COOLDOWNS_MIN, stored.thermalCooldownMin) ? stored.thermalCooldownMin : DEFAULT_THERMAL.cooldownMin;
  const minPct = fanMinPct(fans);
  const asked = typeof stored.fanPct === "number" && Number.isFinite(stored.fanPct) ? stored.fanPct : FAN_DEFAULT_PCT;
  const fanPct = Math.min(FAN_MAX_PCT, Math.max(minPct, Math.round(asked / FAN_STEP_PCT) * FAN_STEP_PCT));
  const fanDelayS = oneOf(FAN_DELAYS_S, stored.fanDelayS) ? stored.fanDelayS : DEFAULT_THERMAL.fanDelayS;
  return { pressure, delayS, cooldownMin, fanPct, fanDelayS, fanMinPct: minPct };
}

/** The busiest fan as a share of its own maximum, or null when there is none to read. */
export function topFanPct(fans: readonly FanReading[] | null): number | null {
  const shares = (fans ?? []).filter((fan) => fan.max > 0).map((fan) => (fan.rpm / fan.max) * 100);
  return shares.length === 0 ? null : Math.max(...shares);
}

export interface ThermalSample {
  at: number;
  /** 0 … 4, or null when it cannot be read. */
  pressure: number | null;
  batteryC: number | null;
  /** null: unknown; []: no fans. */
  fans: readonly FanReading[] | null;
  lidClosed: boolean | null;
  /** Lid mode is on: the triggers act only then. */
  armed: boolean;
}

export interface Trip {
  reason: ThermalReason;
  /** The readings behind it, language-neutral, for the log and the banner. */
  detail: string;
}

export type ThermalState = "normal" | "warm" | "pending" | "blind";

export interface ThermalView {
  state: ThermalState;
  pendingReason: ThermalReason | "";
  /** When the soonest running trigger fires, ms; null when none runs, or the next reading decides. */
  firesAt: number | null;
}

export interface ThermalEvaluator {
  observe(sample: ThermalSample, settings: ThermalSettings): { view: ThermalView; trip: Trip | null };
  /** Forgets every run, after a trip or when lid mode ends. */
  reset(): void;
}

const PRESSURE_NAMES = ["Nominal", "Moderate", "Heavy", "Trapping", "Sleeping"];
export const pressureName = (level: number) => PRESSURE_NAMES[level] ?? String(level);

/** Trips in the order they are named when several are due at once. */
const PRIORITY: ThermalReason[] = ["trapping", "battery", "pressure", "fans", "blind"];

export function createThermalEvaluator(): ThermalEvaluator {
  let moderateSince: number | null = null;
  let heavySince: number | null = null;
  let hotBattery = 0;
  let lastBatteryC = 0;
  let blindSince: number | null = null;
  let fanSince: number | null = null;
  let lastFanPct = 0;

  return {
    reset() {
      moderateSince = null;
      heavySince = null;
      hotBattery = 0;
      blindSince = null;
      fanSince = null;
    },

    observe(sample, settings) {
      const { at } = sample;

      // An unreadable pressure neither starts nor breaks a run: a sensor hiccup in the middle
      // of a heavy spell must not restart its clock. Total loss is the blind trigger's job.
      if (sample.pressure !== null) {
        moderateSince = sample.pressure >= 1 ? (moderateSince ?? at) : null;
        heavySince = sample.pressure >= 2 ? (heavySince ?? at) : null;
      }
      if (sample.batteryC !== null) {
        hotBattery = sample.batteryC >= BATTERY_LIMIT_C ? hotBattery + 1 : 0;
        lastBatteryC = sample.batteryC;
      }
      const blind = sample.lidClosed === true && sample.pressure === null && sample.batteryC === null;
      blindSince = blind ? (blindSince ?? at) : null;
      // The fans count only with the lid closed; between the threshold and 10 points under it
      // a run that has started goes on, so a dip of a few hundred rpm does not restart it.
      const fanPct = topFanPct(sample.fans);
      if (sample.lidClosed !== true || fanPct === null) fanSince = null;
      else if (fanPct >= settings.fanPct) fanSince = fanSince ?? at;
      else if (fanPct < settings.fanPct - FAN_REARM_PCT) fanSince = null;
      if (fanPct !== null) lastFanPct = fanPct;

      const heavyDelayS = settings.pressure === "moderate" ? Math.min(settings.delayS, HEAVY_CAP_S) : settings.delayS;
      const running: Array<{ reason: ThermalReason; firesAt: number | null; detail: string }> = [];
      if (sample.pressure !== null && sample.pressure >= PRESSURE_AT_ONCE) {
        running.push({ reason: "trapping", firesAt: at, detail: pressureName(sample.pressure) });
      }
      if (heavySince !== null) {
        running.push({ reason: "pressure", firesAt: heavySince + heavyDelayS * 1000, detail: `Heavy ${heavyDelayS} s` });
      }
      if (settings.pressure === "moderate" && moderateSince !== null) {
        running.push({ reason: "pressure", firesAt: moderateSince + settings.delayS * 1000, detail: `Moderate ${settings.delayS} s` });
      }
      if (hotBattery > 0) {
        // Counted in readings rather than seconds: the next one decides.
        running.push({ reason: "battery", firesAt: hotBattery >= BATTERY_READINGS ? at : null, detail: `${lastBatteryC.toFixed(1)} °C` });
      }
      if (fanSince !== null) {
        running.push({ reason: "fans", firesAt: fanSince + settings.fanDelayS * 1000, detail: `${Math.round(lastFanPct)} % ${settings.fanDelayS} s` });
      }
      if (blindSince !== null) {
        running.push({ reason: "blind", firesAt: blindSince + BLIND_MS, detail: `${BLIND_MS / 1000} s` });
      }

      const due = running.filter((trigger) => trigger.firesAt !== null && trigger.firesAt <= at);
      const first = due.sort((a, b) => PRIORITY.indexOf(a.reason) - PRIORITY.indexOf(b.reason))[0];
      const trip = sample.armed && first ? { reason: first.reason, detail: first.detail } : null;

      const warm = (sample.batteryC !== null && sample.batteryC >= BATTERY_WARM_C) || (sample.pressure !== null && sample.pressure >= 1);
      // Only an armed guard has something pending: off lid mode nothing is going to act.
      if (!sample.armed || running.length === 0) {
        return { view: { state: warm ? "warm" : "normal", pendingReason: "", firesAt: null }, trip };
      }
      const soonest = running
        .filter((trigger) => trigger.firesAt !== null)
        .reduce<number | null>((min, trigger) => (min === null || (trigger.firesAt as number) < min ? (trigger.firesAt as number) : min), null);
      const named = running.sort((a, b) => PRIORITY.indexOf(a.reason) - PRIORITY.indexOf(b.reason))[0];
      const state: ThermalState = named.reason === "blind" ? "blind" : "pending";
      return { view: { state, pendingReason: named.reason, firesAt: soonest }, trip };
    },
  };
}

/**
 * The cool-down after a trip: the battery at or under 38 °C and the pressure nominal (or not
 * published, then the battery alone), without a break. Anything unreadable breaks it — a
 * Mac that cannot say it is cool is not cool.
 */
export function coolSince(previous: number | null, sample: Pick<ThermalSample, "at" | "pressure" | "batteryC">): number | null {
  const cool = sample.batteryC !== null && sample.batteryC <= BATTERY_COOL_C && (sample.pressure === null || sample.pressure === 0);
  return cool ? (previous ?? sample.at) : null;
}

/**
 * The latch file, shared with the sh guard, so it is `key=value` lines rather than JSON: the
 * guard writes it with printf and reads it with grep. `at` is in Unix seconds.
 */
export interface LatchRecord {
  at: number;
  reason: ThermalReason;
  detail: string;
  dryRun: boolean;
  slept: boolean | null;
  holders: string[];
  by: string;
  dismissed: boolean;
}

const REASONS: readonly ThermalReason[] = ["trapping", "pressure", "battery", "blind", "fans"];

export function parseLatch(text: string): LatchRecord | null {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([a-z]+)=(.*)$/.exec(line.trim());
    // The last write of a key wins: the guard appends `slept=` after the fact.
    if (match) values.set(match[1], match[2]);
  }
  const at = Number(values.get("at"));
  const reason = values.get("reason") as ThermalReason | undefined;
  if (!Number.isFinite(at) || at <= 0 || !reason || !REASONS.includes(reason)) return null;
  const slept = values.get("slept");
  return {
    at,
    reason,
    detail: values.get("detail") ?? "",
    dryRun: values.get("dry") === "1",
    slept: slept === "1" ? true : slept === "0" ? false : null,
    holders: (values.get("holders") ?? "").split(/\s+/).filter((holder) => holder !== ""),
    by: values.get("by") ?? "",
    dismissed: values.get("dismissed") === "1",
  };
}

/** One line per key; values never carry a newline (detail and holders are made here). */
export function formatLatch(record: LatchRecord): string {
  const clean = (value: string) => value.replace(/[\r\n]+/g, " ");
  const lines = [
    `at=${Math.round(record.at)}`,
    `reason=${record.reason}`,
    `detail=${clean(record.detail)}`,
    `dry=${record.dryRun ? 1 : 0}`,
    `by=${clean(record.by)}`,
  ];
  if (record.slept !== null) lines.push(`slept=${record.slept ? 1 : 0}`);
  if (record.holders.length > 0) lines.push(`holders=${clean(record.holders.join(" "))}`);
  if (record.dismissed) lines.push("dismissed=1");
  return `${lines.join("\n")}\n`;
}

/** The settings as the sh guard reads them: `KEY=number` lines, nothing it would execute. */
export function formatGuardConf(settings: ThermalSettings, helper: string): string {
  return [
    `PRESSURE_LEVEL=${settings.pressure === "moderate" ? 1 : 2}`,
    `PRESSURE_DELAY=${settings.delayS}`,
    `FAN_PCT=${settings.fanPct}`,
    `FAN_DELAY=${settings.fanDelayS}`,
    // A path, so the guard checks it is an executable file before running it.
    `HELPER=${helper.replace(/[\r\n]+/g, "")}`,
    "",
  ].join("\n");
}
