import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Caffeine's preferences, kept by the host: Settings → Plugins → Caffeine → Settings.
 * `timer` and `warmup` put their rows on the page; both are hidden until asked for. `warmup`
 * off also switches warm-up itself off (the server sees to it), so nothing unseen messages the
 * accounts every morning. A running timer is not touched by hiding its row: it shows in the
 * state card and ends on time.
 *
 * The rest is the heat guard of lid mode (server/thermal.ts says what each one means). The
 * schema only checks shapes: which delays go with which pressure level, and how low the fan
 * threshold may go on this machine, is the server's to settle (`normalizeThermal`), so a value
 * written by an older client or by hand still lands on something safe. The battery limit is
 * deliberately not here: it is fixed.
 */
export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 3,
  schema: z.object({
    timer: z.boolean().default(false),
    warmup: z.boolean().default(false),
    /** The pressure level that puts a closed Mac in lid mode to sleep, after `thermalDelayS`. */
    thermalPressure: z.enum(["heavy", "moderate"]).default("heavy"),
    thermalDelayS: z.number().int().default(60),
    /** How long the Mac has to stay cool before lid mode may be turned on again by hand. */
    thermalCooldownMin: z.number().int().default(5),
    /** The fans' trigger: any fan at this share of its own maximum, for `fanDelayS`. */
    fanPct: z.number().int().default(85),
    fanDelayS: z.number().int().default(60),
  }),
  // The host keeps the whole document, defaults included, so a new default reaches nobody who
  // has one: version 3 hides the timer and warm-up for everyone once, and they can be shown
  // again. Version 1's other keys came in at their defaults.
  migrate: (values, fromVersion) => (fromVersion < 3 ? { ...(values as object), timer: false, warmup: false } : values),
});

/**
 * The heat guard's fixed numbers and the choices its settings offer, shared so the page, the
 * Settings screen and the server agree (server/thermal.ts explains each).
 */
export const THERMAL_LIMITS = {
  batteryLimitC: 45,
  batteryWarmC: 40,
  batteryCoolC: 38,
  blindS: 90,
  heavyDelaysS: [30, 60, 120],
  moderateDelaysS: [120, 300, 600],
  cooldownsMin: [5, 10, 20, 30],
  fanDelaysS: [30, 60, 120, 300],
  fanMaxPct: 95,
  fanStepPct: 5,
  fanDefaultPct: 85,
} as const;

export type Preferences = z.output<typeof preferences.schema>;

export const defaultPreferences: Preferences = {
  timer: false,
  warmup: false,
  thermalPressure: "heavy",
  thermalDelayS: 60,
  thermalCooldownMin: 5,
  fanPct: 85,
  fanDelayS: 60,
};

export const mode = z.enum(["off", "on", "timer", "auto"]);
/** Minutes rather than hours: the shortest hold is half of one. */
export const timerMinutes = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(180),
  z.literal(480),
  z.literal(720),
]);

/**
 * What the Mac's own battery says. Absent on a machine without one, which is why every
 * client has to cope with null rather than with a zero percent charge.
 */
export const battery = z.object({
  percent: z.number().int().min(0).max(100),
  charging: z.boolean(),
  /** Charged and still on the charger: neither filling nor draining. */
  charged: z.boolean(),
  external: z.boolean(),
  /** Minutes until empty, or until full while charging; null when there is no estimate. */
  minutes: z.number().int().nonnegative().nullable(),
  /** What the charger is rated for, in watts; null off the charger or when macOS will not say. */
  adapterWatts: z.number().nonnegative().nullable().default(null),
  /** What the Mac is taking from the charger right now, in watts; null off the charger. */
  inputWatts: z.number().nonnegative().nullable().default(null),
  /** Into the battery when positive, out of it when negative; null when unknown. */
  batteryWatts: z.number().nullable().default(null),
});


/** Whether the one-time permission for lid mode is in place. */
export const lidSetup = z.enum(["unknown", "needs-setup", "ready"]);

/** Lid mode: the Mac keeps running with the lid closed. `on` is read from the system. */
export const lidStatus = z.object({
  on: z.boolean().default(false),
  /** RFC 3339 deadline, or "" when not set by Caffeine. */
  until: z.string().default(""),
  /** The length that was picked; 0 when off or set outside Caffeine. */
  minutes: z.number().int().nonnegative().default(0),
  /** On with no end. */
  forever: z.boolean().default(false),
  /** Why lid mode last ended by itself ("battery", "heat"), or "". */
  ended: z.enum(["", "battery", "heat"]).default(""),
  /**
   * Who else turned it off: "sleep" (Sleep now), "off" (the header), "manual" (sleep switched
   * back on outside Caffeine), or "". A string rather than an enum, so a client older than a
   * new reason still reads the status.
   */
  stopped: z.string().default(""),
  setup: lidSetup.default("unknown"),
  /** "needs-setup", a failed command's message, or "". */
  error: z.string().default(""),
});

/** Session warm-up: a tiny Haiku message per Claude login at a set hour. */
export const warmupStatus = z.object({
  enabled: z.boolean().default(false),
  /** Local time of day, "HH:MM". */
  time: z.string().default("06:00"),
  /** The next scheduled warm-up, RFC 3339, or "" when off. */
  nextAt: z.string().default(""),
  /** The last warm-up, scheduled or by hand, RFC 3339, or "". */
  lastAt: z.string().default(""),
  results: z.array(z.object({ login: z.string(), ok: z.boolean(), error: z.string().default("") })).default([]),
  running: z.boolean().default(false),
});

/** One fan as the SMC reports it; `manual` when another app has taken the fan over. */
export const fanReading = z.object({
  rpm: z.number().nonnegative(),
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
  manual: z.boolean().default(false),
});

/** Why the heat guard put the Mac to sleep (or, in a dry run, would have). */
export const thermalReason = z.enum(["trapping", "pressure", "battery", "blind", "fans"]);

/** One trip of the heat guard, as the latch file records it. */
export const thermalEvent = z.object({
  /** RFC 3339. */
  at: z.string(),
  reason: thermalReason,
  /** The readings that tripped it, in words for the log and the banner. */
  detail: z.string().default(""),
  /** Nothing was done: the dry-run switch was on, or the readings were simulated. */
  dryRun: z.boolean().default(false),
  /** Whether the sleep was seen to happen; null while unknown. */
  slept: z.boolean().nullable().default(null),
  /** Other processes that held the Mac awake when sleep did not take. */
  holders: z.array(z.string()).default([]),
  /** "plugin" or "guard": whichever saw it first. */
  by: z.string().default(""),
});

/** The heat guard's settings as the server applies them, after normalising. */
export const thermalSettings = z.object({
  pressure: z.enum(["heavy", "moderate"]).default("heavy"),
  delayS: z.number().int().default(60),
  cooldownMin: z.number().int().default(5),
  fanPct: z.number().int().default(85),
  fanDelayS: z.number().int().default(60),
  /** The lowest fan threshold this machine allows: a little above its fans' floor. */
  fanMinPct: z.number().int().default(40),
});

/**
 * The heat block and what the guard is doing. Readings are null when they cannot be had,
 * `fans` is [] on a Mac without fans. `armed` is lid mode: the guard acts only then, since
 * that is when Caffeine has switched off macOS's own way out.
 */
export const thermalStatus = z.object({
  /** macOS's thermal pressure: 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping. */
  pressure: z.number().int().min(0).max(4).nullable().default(null),
  batteryC: z.number().nullable().default(null),
  /** The hottest of the die sensors, only when enough of them read sensibly. */
  cpuC: z.number().nullable().default(null),
  fans: z.array(fanReading).nullable().default(null),
  /** Why CPU and fans are missing: "" when the sensor helper runs, else a short reason. */
  sensors: z.string().default(""),
  lidClosed: z.boolean().nullable().default(null),
  armed: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  simulated: z.boolean().default(false),
  state: z.enum(["normal", "warm", "pending", "blind", "latched"]).default("normal"),
  /** While pending: which trigger, and when it fires (RFC 3339). */
  pendingReason: z.string().default(""),
  firesAt: z.string().default(""),
  /** The trip that is keeping lid mode off until the Mac has cooled down. */
  latch: thermalEvent.nullable().default(null),
  /** Whether the cool-down is done, and when it will be (RFC 3339, "" when unknown). */
  cool: z.boolean().default(false),
  coolAt: z.string().default(""),
  /** The last trip, for the banner, until somebody dismisses it. */
  event: thermalEvent.nullable().default(null),
  settings: thermalSettings.default({ pressure: "heavy", delayS: 60, cooldownMin: 5, fanPct: 85, fanDelayS: 60, fanMinPct: 40 }),
});

/** What every client sees. `until` and `tickAt` are RFC 3339 or empty. */
export const status = z.object({
  mode,
  until: z.string().default(""),
  active: z.boolean(),
  busy: z.boolean(),
  agents: z.number().int().nonnegative(),
  error: z.string().default(""),
  tickAt: z.string().default(""),
  /** Whether the display is held awake along with the system. */
  keepDisplay: z.boolean().default(false),
  /** Whether the timer and On also let the lid close (lid mode for the same time). */
  lidClosed: z.boolean().default(false),
  /**
   * The link that wakes this Mac from the local network, or "" when the anchor could not
   * be raised. Carried in the status rather than fetched on its own, because the address
   * in it changes with the network and the surface already re-reads this every five
   * seconds.
   */
  wakeUrl: z.string().default(""),
  battery: battery.nullable().default(null),
  lid: lidStatus.default({ on: false, until: "", minutes: 0, forever: false, ended: "", stopped: "", setup: "unknown", error: "" }),
  warmup: warmupStatus.default({ enabled: false, time: "06:00", nextAt: "", lastAt: "", results: [], running: false }),
  thermal: thermalStatus.prefault({}),
});

/**
 * What a change answers: the status after it, and a verdict on this one call, read from the
 * system after the change rather than from what was asked (server/actions.server.ts). An
 * assistant relaying the answer (God Mode, see server/capabilities.server.ts) reports a
 * refusal as not done; the page reads the status and ignores both.
 */
export const answer = status.extend({
  /** Why nothing was changed, or "" when the change was made. */
  refused: z.string().default(""),
  /** What did not take although the change was made (lid mode that did not come on, a hold
   *  that could not start), or "". */
  problem: z.string().default(""),
});

export const setInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("on") }),
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("timer"), minutes: timerMinutes }),
]);

/** A patch: whatever is left out keeps the value it already had. */
export const setOptionsInput = z.object({
  keepDisplay: z.boolean().optional(),
  lidClosed: z.boolean().optional(),
});

export type Mode = z.output<typeof mode>;
export type Status = z.output<typeof status>;
export type Answer = z.output<typeof answer>;
export type SetInput = z.output<typeof setInput>;
export type SetOptionsInput = z.output<typeof setOptionsInput>;
export type Battery = z.output<typeof battery>;
/** Who turned lid mode off, when it was not a timer, a mode change, a low battery or heat. */
export type LidStopped = "sleep" | "off" | "manual";
export type LidSetup = z.output<typeof lidSetup>;
export type LidStatus = z.output<typeof lidStatus>;
export type WarmupStatus = z.output<typeof warmupStatus>;
export type FanReading = z.output<typeof fanReading>;
export type ThermalReason = z.output<typeof thermalReason>;
export type ThermalEvent = z.output<typeof thermalEvent>;
export type ThermalSettings = z.output<typeof thermalSettings>;
export type ThermalStatus = z.output<typeof thermalStatus>;

/** Puts the heat guard's last trip away: the banner goes, the latch (if any) stays. */
export const dismissThermal = defineRpc({
  name: "caffeine.thermal-dismiss",
  input: z.object({}),
  output: answer,
});

export const getStatus = defineRpc({
  name: "caffeine.get",
  input: z.object({}),
  output: status,
});

export const setMode = defineRpc({
  name: "caffeine.set",
  input: setInput,
  output: answer,
});

/**
 * Separate from `setMode` on purpose: the display switch is orthogonal to the mode, and
 * folding it into that discriminated union would make every mode change carry it from
 * the client — and eventually drop it.
 */
export const setOptions = defineRpc({
  // Lower case only: the SDK matches method names against /^[a-z][a-z0-9._-]*$/ and
  // throws on a capital, which takes the whole plugin down at import time.
  name: "caffeine.set-options",
  input: setOptionsInput,
  output: answer,
});

/**
 * The other direction: not a mode that outlives the call, but one act. The status comes
 * back describing the Mac a second before it goes under — by design, since the caller is
 * usually a phone that is about to lose the connection anyway and wants to know the
 * request was taken, not what the machine looks like while it suspends.
 */
/**
 * How long the Mac gets after answering before it actually suspends. Shared rather than
 * server-side only, because the client counts down the same second on screen — a bar
 * that finishes early or late reads as a lie about what the machine is doing.
 */
export const SLEEP_DELAY_MS = 1_000;

export const sleepNow = defineRpc({
  name: "caffeine.sleep",
  input: z.object({}),
  output: answer,
});

/** "off" is the header alert's one action. "on" turns lid mode back on the way the timer or
 *  On and the lid switch say, after something else turned it off; it never sets a length of
 *  its own. */
export const setLid = defineRpc({
  name: "caffeine.lid",
  input: z.object({ lid: z.enum(["on", "off"]) }),
  output: answer,
});

/** The one-time permission for lid mode, through macOS's own password dialog on the Mac. */
export const setupLid = defineRpc({
  name: "caffeine.lid-setup",
  input: z.object({}),
  output: status,
});

/** The warm-up's hour. */
export const warmupTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("Local time of day, HH:MM on a 24-hour clock");

/** Turns the warm-up on or off, or moves its hour. */
export const setWarmup = defineRpc({
  name: "caffeine.warmup",
  input: z.object({
    enabled: z.boolean().optional(),
    time: warmupTime.optional(),
  }),
  output: answer,
});

/**
 * Warms every login up now, whatever the schedule; answers once it is done. `wait: false`
 * answers at once instead, with the warm-up running, for a caller that cannot wait: a plugin
 * RPC times out at 30 s, and a warm-up takes seconds per login.
 */
export const runWarmup = defineRpc({
  name: "caffeine.warmup-now",
  input: z.object({ wait: z.boolean().default(true) }),
  output: answer,
});

