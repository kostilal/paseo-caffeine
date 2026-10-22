import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
export type SetInput = z.output<typeof setInput>;
export type SetOptionsInput = z.output<typeof setOptionsInput>;
export type Battery = z.output<typeof battery>;
/** Who turned lid mode off, when it was not a timer, a mode change, a low battery or heat. */
export type LidStopped = "sleep" | "off" | "manual";
export type LidSetup = z.output<typeof lidSetup>;
export type LidStatus = z.output<typeof lidStatus>;
export type WarmupStatus = z.output<typeof warmupStatus>;

export const getStatus = defineRpc({
  name: "caffeine.get",
  input: z.object({}),
  output: status,
});

export const setMode = defineRpc({
  name: "caffeine.set",
  input: setInput,
  output: status,
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
  output: status,
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
  output: status,
});

/** "off" is the header alert's one action. "on" turns lid mode back on the way the timer or
 *  On and the lid switch say, after something else turned it off; it never sets a length of
 *  its own. */
export const setLid = defineRpc({
  name: "caffeine.lid",
  input: z.object({ lid: z.enum(["on", "off"]) }),
  output: status,
});

/** The one-time permission for lid mode, through macOS's own password dialog on the Mac. */
export const setupLid = defineRpc({
  name: "caffeine.lid-setup",
  input: z.object({}),
  output: status,
});

/** Turns the warm-up on or off, or moves its hour. */
export const setWarmup = defineRpc({
  name: "caffeine.warmup",
  input: z.object({
    enabled: z.boolean().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  }),
  output: status,
});

/** Warms every login up now, whatever the schedule; answers once it is done. */
export const runWarmup = defineRpc({
  name: "caffeine.warmup-now",
  input: z.object({}),
  output: status,
});

