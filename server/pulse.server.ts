import { createHash } from "node:crypto";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Status, ThermalStatus } from "../shared/caffeine.shared.ts";
import { lidOffReason, lidWanted } from "./actions.server.ts";
import type { EventRing, EventsPage } from "./pulse-events.server.ts";
import { SKIP_NOT_SUBSCRIPTION } from "./warmup.server.ts";

/**
 * Caffeine as a source of Paseo Pulse, which shows plugins' readings in Paseo, in widgets and
 * in notifications (contract `paseo.pulse/1`). Three RPCs and nothing else: `meta.pulse` says
 * what there is (the manifest), `caffeine.pulse` reads it (a snapshot of the status the
 * controller already holds: no process, no network), and `caffeine.pulse-events` hands over
 * what happened since a cursor (server/pulse-events.server.ts).
 *
 * Every action is an operation of `meta.describe` (server/capabilities.server.ts) by the same
 * id, so its risk, fixed arguments, confirmation and outcome come from there and are not
 * repeated here. The "Show in Pulse" switch in Caffeine's Settings takes the readings out and
 * marks every action "never"; the handlers themselves never refuse, since they cannot tell
 * Pulse from anybody else.
 */

export const PULSE_SCHEMA = "paseo.pulse/1";

// The daemon parses every answer with its contract's output schema, and a plain z.object drops
// the keys it does not name, so these shells are loose on purpose: Pulse validates the
// contract, this only says which answer it is.
export const pulseManifestRpc = defineRpc({
  name: "meta.pulse",
  input: z.object({}),
  output: z.looseObject({ schema: z.literal(PULSE_SCHEMA), manifestRev: z.string() }),
});

export const pulseSnapshotRpc = defineRpc({
  name: "caffeine.pulse",
  input: z.object({ ifRev: z.string().optional() }),
  // A full snapshot, or { unchanged: true, rev } when `ifRev` is still the current one.
  output: z.looseObject({ schema: z.literal(PULSE_SCHEMA), rev: z.string() }),
});

export const pulseEventsRpc = defineRpc({
  name: "caffeine.pulse-events",
  input: z.object({ after: z.string().nullable().optional(), limit: z.number().int().positive().optional() }),
  output: z.looseObject({ schema: z.literal(PULSE_SCHEMA), head: z.string() }),
});

type Text = string | { en: string; [lang: string]: string };
const t = (en: string, ru: string): Text => ({ en, ru });

/** Objects with sorted keys, so the same values always hash the same. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}

/** The contract's revision hash: what crosses the wire (undefined keys gone), keys sorted. */
export function pulseRev(value: unknown): string {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return `r${createHash("sha256").update(JSON.stringify(sorted(plain)), "utf8").digest("base64url").slice(0, 22)}`;
}

/**
 * The readings, in the order Pulse ranks them. A time right after a state is that state's pair
 * (mode + until, heat + heat_fires, warmup + warmup_next). The battery's 20 % is where lid mode
 * ends off the charger (LID_LOW_BATTERY); the battery's 40 and 45 °C are the heat guard's own
 * (THERMAL_LIMITS). The CPU has no thresholds: the guard does not use it, and a busy Apple
 * Silicon Mac runs hot without anything being wrong.
 */
export const PULSE_METRICS = [
  {
    id: "mode",
    type: "state",
    glance: true,
    symbol: "cup.and.saucer",
    title: t("Keep awake", "Не спать"),
    short: t("Awake", "Бодр"),
    states: {
      off: { title: t("Off", "Выкл") },
      on: { title: t("On", "Вкл"), severity: "ok", symbol: "cup.and.saucer.fill" },
      timer: { title: t("Timer", "Таймер"), severity: "ok", symbol: "timer" },
      auto: { title: t("While agents work", "Пока работают агенты"), short: t("Auto", "Авто"), severity: "info", symbol: "sparkles" },
    },
  },
  { id: "until", type: "time", style: "countdown", title: t("Awake until", "Не спать до"), short: t("Until", "До") },
  {
    id: "hold",
    type: "state",
    title: t("Hold", "Удержание"),
    states: {
      held: { title: t("Holding", "Держит"), severity: "ok" },
      idle: { title: t("Not holding", "Не держит") },
      suspended: { title: t("Suspended", "Пауза"), severity: "warning" },
      failed: { title: t("Failed", "Сбой"), severity: "critical" },
    },
  },
  {
    id: "lid",
    type: "state",
    title: t("Lid mode", "Режим крышки"),
    symbol: "laptopcomputer",
    states: {
      on: { title: t("On", "Вкл"), severity: "ok" },
      off: { title: t("Off", "Выкл") },
      blocked: { title: t("Blocked", "Заблокирован"), short: t("Block", "Блок"), severity: "warning" },
    },
  },
  {
    id: "battery",
    type: "bounded",
    unit: "percent",
    min: 0,
    max: 100,
    glance: true,
    history: true,
    staleAfterSec: 120,
    title: t("Battery", "Батарея"),
    short: t("Bat", "Бат"),
    symbol: "battery.75percent",
    thresholds: { below: [[20, "warning"], [10, "critical"]], clearBy: 3 },
  },
  {
    id: "battery_temp",
    type: "bounded",
    unit: "celsius",
    min: 20,
    max: 60,
    history: true,
    staleAfterSec: 60,
    title: t("Battery temperature", "Темп. батареи"),
    short: t("Bat°", "Бат°"),
    symbol: "thermometer.medium",
    thresholds: { above: [[40, "warning"], [45, "critical"]] },
  },
  { id: "cpu", type: "bounded", unit: "celsius", min: 30, max: 110, history: true, staleAfterSec: 60, title: "CPU", symbol: "cpu", surfaces: { only: ["card"] } },
  {
    id: "heat",
    type: "state",
    glance: true,
    symbol: "thermometer.medium",
    title: t("Heat guard", "Нагрев"),
    states: {
      normal: { title: t("Normal", "Норма"), severity: "ok" },
      warm: { title: t("Warm", "Тепло"), severity: "warning" },
      pending: { title: t("About to sleep", "Сейчас уснёт"), short: t("Sleep", "Сон"), severity: "critical" },
      blind: { title: t("No sensors", "Нет датчиков"), short: t("Blind", "Вслеп"), severity: "warning" },
      latched: { title: t("Cooling down", "Остывает"), short: t("Cool", "Остыв"), severity: "warning" },
    },
  },
  { id: "heat_fires", type: "time", style: "countdown", title: t("Sleeps in", "Уснёт через"), short: t("In", "Через") },
  {
    id: "warmup",
    type: "state",
    title: t("Session warm-up", "Прогрев"),
    surfaces: { only: ["card"] },
    states: {
      off: { title: t("Off", "Выкл") },
      on: { title: t("On", "Вкл"), severity: "ok" },
      running: { title: t("Running", "Идёт"), severity: "info" },
      failed: { title: t("Failed", "Сбой"), severity: "warning" },
    },
  },
  { id: "warmup_next", type: "time", style: "clock", title: t("Next warm-up", "Следующий прогрев"), surfaces: { only: ["card"] } },
] as const;

export type PulseMetricId = (typeof PULSE_METRICS)[number]["id"];

const hours = (id: string, minutes: number, en: string, ru: string) => ({ id, title: t(en, ru), args: { minutes } });

/**
 * The operations Pulse may offer, by their `meta.describe` id. `on` only for low-risk ones that
 * need no confirmation; the ones that can let the Mac sleep start off, and Pulse only ever
 * offers them in the app, after a confirmation. The timer's presets are exactly its lengths,
 * the two most used first. The rest are left out on purpose (NOT_FOR_PULSE).
 */
export const PULSE_ACTIONS = [
  { id: "keep_awake", operation: "keep_awake", title: t("Keep awake", "Не спать"), symbol: "cup.and.saucer.fill", exposure: "on" },
  {
    id: "keep_awake_for",
    operation: "keep_awake_for",
    title: t("Keep awake", "Не спать"),
    symbol: "timer",
    exposure: "on",
    presets: [
      hours("h1", 60, "1 h", "1 ч"),
      hours("h2", 120, "2 h", "2 ч"),
      hours("m30", 30, "30 m", "30 м"),
      hours("h3", 180, "3 h", "3 ч"),
      hours("h8", 480, "8 h", "8 ч"),
      hours("h12", 720, "12 h", "12 ч"),
    ],
  },
  { id: "dismiss_heat_alert", operation: "dismiss_heat_alert", title: t("Dismiss", "Скрыть"), symbol: "xmark", exposure: "on" },
  { id: "lid_back_on", operation: "lid_back_on", title: t("Lid mode on", "Крышка: вкл"), symbol: "laptopcomputer", exposure: "off" },
  { id: "allow_sleep", operation: "allow_sleep", title: t("Let it sleep", "Разрешить сон"), symbol: "moon", exposure: "off" },
  { id: "auto", operation: "auto", title: t("While agents work", "Пока работают агенты"), symbol: "sparkles", exposure: "off" },
  { id: "sleep_now", operation: "sleep_now", title: t("Sleep now", "Усыпить"), symbol: "moon.zzz", exposure: "off" },
  { id: "lid_off_now", operation: "lid_off_now", title: t("End lid mode", "Выкл. крышку"), symbol: "laptopcomputer.slash", exposure: "off" },
];

/** The `meta.describe` actions Pulse never offers, and why. The tests want every action
 *  either in PULSE_ACTIONS or here. */
export const NOT_FOR_PULSE: Record<string, string> = {
  keep_display: "The display matters to whoever sits at the Mac; from a widget or a phone it changes nothing they can see.",
  allow_lid_closed: "The lid switch is a standing choice for the timer and On, made on the page; Pulse shows lid mode and can end it (lid_off_now).",
  stop_lid_closed: "The same standing choice as allow_lid_closed, made on the page; ending lid mode now is lid_off_now.",
  warmup_on: "Sends a message from every Claude login every day: a schedule set on the page, not a one-glance button.",
  warmup_hour: "Needs an hour of the day, and Pulse passes no free arguments.",
  warmup_off: "Part of the same schedule as warmup_on, which lives on the page.",
  warmup_now: "Sends a message from every Claude login at once: not a button for a widget or a notification.",
};

/** What happened, for notifications. Trips seen by either guard; dry runs and simulations as
 *  info, so the whole path can be tried without a hot Mac. */
export const PULSE_EVENT_TYPES = [
  {
    type: "heat_trip",
    title: "Heat guard tripped",
    severity: "critical",
    group: "heat",
    ttlSec: 3600,
    fields: { reason: "string", detail: "string", by: "string" },
    template: { title: t("Heat guard tripped: {reason}", "Сработал тепловой страж: {reason}"), body: "{detail}" },
    actions: ["dismiss_heat_alert"],
  },
  {
    type: "heat_sleep_failed",
    title: "Mac could not sleep",
    severity: "critical",
    group: "heat",
    fields: { reason: "string", detail: "string", by: "string", holders: "string" },
    template: { title: t("The Mac could not be put to sleep", "Mac не удалось усыпить"), body: t("held by {holders}", "держат: {holders}") },
  },
  {
    type: "heat_trip_dry",
    title: "Heat guard dry run",
    severity: "info",
    group: "heat",
    fields: { reason: "string", detail: "string", by: "string" },
    template: { title: t("Heat guard dry run: {reason}", "Пробный запуск стража: {reason}") },
  },
  {
    type: "lid_ended",
    title: "Lid mode ended",
    severity: "warning",
    group: "lid",
    ttlSec: 3600,
    fields: { why: "string", detail: "string" },
    template: { title: t("Lid mode ended", "Режим крышки выключен"), body: "{detail}" },
  },
  {
    type: "warmup_failed",
    title: "Warm-up failed",
    severity: "warning",
    fields: { failed: "number", total: "number" },
    template: { title: t("Session warm-up failed for {failed} of {total} logins", "Прогрев не удался у {failed} из {total} логинов") },
  },
];

export type PulseManifest = Record<string, unknown> & { schema: typeof PULSE_SCHEMA; manifestRev: string; metrics: ReadonlyArray<{ id: string }> };

/** The manifest, with or without Caffeine shown in Pulse. `manifestRev` is the hash of the
 *  rest, so flipping the switch changes it by itself. */
export function buildManifest(shown: boolean): PulseManifest {
  const body = {
    schema: PULSE_SCHEMA,
    title: t("Caffeine", "Кофеин"),
    symbol: "cup.and.saucer",
    snapshot: { method: pulseSnapshotRpc.name, cost: "local", minIntervalSec: 5, suggestedIntervalSec: 15, supportsIfRev: true },
    events: { method: pulseEventsRpc.name, minIntervalSec: 10 },
    metrics: shown ? PULSE_METRICS : [],
    actions: shown ? PULSE_ACTIONS : PULSE_ACTIONS.map((action) => ({ ...action, exposure: "never" })),
    // Hidden actions leave the notifications too; the heat alerts themselves still come.
    eventTypes: shown ? PULSE_EVENT_TYPES : PULSE_EVENT_TYPES.map(({ actions: _, ...type }) => type),
  } as const;
  return { ...body, manifestRev: pulseRev(body) };
}

export type Reading = Record<string, unknown>;

const finite = (value: number | null): value is number => typeof value === "number" && Number.isFinite(value);
/** A note is cut at 120 code points by Pulse; cut here so the hash sees what Pulse keeps. */
const note = (text: string) => [...text].slice(0, 120).join("");
const empty: Reading = { availability: "empty" };

function powerNote(battery: NonNullable<Status["battery"]>): Reading {
  if (battery.charging) return { note: "charging" };
  if (battery.charged) return { note: "charged" };
  if (battery.external) return { note: "on the charger" };
  return {};
}

/**
 * The status as Pulse readings. Nothing that ticks on its own goes in (`tickAt`, `busy`, the
 * battery's minutes and watts), nor anything personal (the wake link, the warm-up's logins),
 * so the snapshot's `rev` only moves when something worth showing does. Temperatures are
 * rounded for the same reason: the CPU to a degree, the battery to half of one.
 */
export function pulseValues(status: Status): Record<PulseMetricId, Reading> {
  const th = status.thermal;
  const simulated = th.simulated ? ["simulated"] : [];
  const noted = (parts: string[]): Reading => (parts.length ? { note: note(parts.join("; ")) } : {});
  // The hold is wanted under On and the timer, and under Auto while an agent works.
  const wanted = status.mode === "on" || status.mode === "timer" || (status.mode === "auto" && status.busy);
  const suspended = wanted && !status.active && th.latch !== null && th.lidClosed !== false;
  const lastFailed = status.warmup.results.some((result) => !result.ok && result.error !== SKIP_NOT_SUBSCRIPTION);
  return {
    mode: { state: status.mode },
    until: status.mode === "timer" && status.until !== "" ? { at: status.until } : empty,
    hold:
      status.error !== ""
        ? { state: "failed", note: note(status.error) }
        : status.active
          ? { state: "held" }
          : suspended
            ? { state: "suspended", note: "the heat guard holds it off" }
            : { state: "idle" },
    lid: status.lid.on ? { state: "on" } : lidWanted(status) ? { state: "blocked", note: note(lidOffReason(status)) } : { state: "off" },
    battery: status.battery === null ? { availability: "unavailable", note: "no battery" } : { value: status.battery.percent, ...powerNote(status.battery) },
    battery_temp: finite(th.batteryC) ? { value: Math.round(th.batteryC * 2) / 2, ...noted(simulated) } : { availability: "unavailable" },
    cpu: finite(th.cpuC) ? { value: Math.round(th.cpuC), ...noted(simulated) } : { availability: "unavailable", ...noted(th.sensors ? [th.sensors] : []) },
    heat: { state: th.state, ...noted([...(th.pendingReason ? [th.pendingReason] : []), ...simulated]) },
    heat_fires: (th.state === "pending" || th.state === "blind") && th.firesAt !== "" ? { at: th.firesAt } : empty,
    warmup: { state: !status.warmup.enabled ? "off" : status.warmup.running ? "running" : lastFailed ? "failed" : "on" },
    warmup_next: status.warmup.nextAt !== "" ? { at: status.warmup.nextAt } : empty,
  };
}

export interface PulseDeps {
  ring: EventRing;
  status(): Status;
  now?: () => number;
  /** How long the manifest and the snapshot wait for the first read of the settings. */
  settleMs?: number;
}

export interface Pulse {
  manifest(): Promise<PulseManifest>;
  snapshot(input: { ifRev?: string }): Promise<{ schema: typeof PULSE_SCHEMA; rev: string; [key: string]: unknown }>;
  events(input: { after?: string | null; limit?: number }): { schema: typeof PULSE_SCHEMA; [key: string]: unknown } & EventsPage;
  /** The "Show in Pulse" switch, whenever the settings are read. */
  setShown(shown: boolean): void;
  /** No settings to wait for: Caffeine stays shown. */
  settingsUnavailable(): void;
  /** The start chain (lid, warm-up, the anchor, the controller) is through, or it failed. */
  started(ok: boolean): void;
  /** After every look of the heat guard: a trip it has not reported yet becomes an event. */
  heatSeen(thermal: ThermalStatus): void;
  /** Lid mode ended by itself (lid.server.ts): low battery, heat, or sleep switched on by hand. */
  lidEnded(why: "battery" | "heat" | "manual", detail: string): void;
  /** A warm-up ran (warmup.server.ts). */
  warmupRan(run: { at: string; total: number; failed: number }): void;
}

export function createPulse(deps: PulseDeps): Pulse {
  const now = deps.now ?? Date.now;
  /** A trip older than this process was the news of the one before; this one never saw it. */
  const bornAt = now();
  let shown = true;
  let state: "starting" | "ready" | "failed" = "starting";
  const manifests = new Map<boolean, PulseManifest>();
  const manifestFor = (value: boolean) => {
    let manifest = manifests.get(value);
    if (!manifest) manifests.set(value, (manifest = buildManifest(value)));
    return manifest;
  };

  // Right after a restart the switch is not read yet: without the wait, a hidden Caffeine would
  // show for a moment.
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  setTimeout(() => settle(), deps.settleMs ?? 1000).unref?.();

  const isoNow = () => new Date(now()).toISOString();

  return {
    async manifest() {
      await settled;
      return manifestFor(shown);
    },

    async snapshot({ ifRev }) {
      await settled;
      const manifest = manifestFor(shown);
      let values: Record<string, Reading>;
      let asOf = isoNow();
      if (state === "ready") {
        const status = deps.status();
        values = shown ? pulseValues(status) : {};
        if (status.tickAt !== "") asOf = status.tickAt;
      } else {
        // Before the start chain is through the controller says "off" from its defaults, which
        // is not true: every reading is empty (or an error) until it is.
        const placeholder = state === "starting" ? { availability: "empty", note: "starting" } : { availability: "error", note: "Caffeine did not start" };
        values = Object.fromEntries(manifest.metrics.map((metric) => [metric.id, placeholder]));
      }
      const body = { schema: PULSE_SCHEMA as typeof PULSE_SCHEMA, manifestRev: manifest.manifestRev, events: { head: deps.ring.head() }, values };
      const rev = pulseRev(body);
      if (ifRev === rev) return { schema: PULSE_SCHEMA as typeof PULSE_SCHEMA, unchanged: true, rev, manifestRev: manifest.manifestRev, asOf };
      return { ...body, rev, asOf };
    },

    events: (input) => ({ schema: PULSE_SCHEMA as typeof PULSE_SCHEMA, ...deps.ring.read(input) }),

    setShown(value) {
      shown = value;
      settle();
    },

    settingsUnavailable: () => settle(),

    started(ok) {
      state = ok ? "ready" : "failed";
    },

    heatSeen(thermal) {
      // The banner's trip, or the latch's once the banner is dismissed: the same record.
      const trip = thermal.event ?? thermal.latch;
      if (!trip) return;
      // The latch file outlives a restart; its trip is rounded to the second.
      if (!(Date.parse(trip.at) >= bornAt - 1000)) return;
      const fields = { reason: trip.reason, detail: trip.detail, by: trip.by };
      deps.ring.push(trip.dryRun ? "heat_trip_dry" : "heat_trip", fields, { at: trip.at, key: `heat:${trip.at}` });
      if (trip.slept === false) {
        deps.ring.push("heat_sleep_failed", { ...fields, holders: trip.holders.join(", ") || "unknown" }, { at: isoNow(), key: `heat-fail:${trip.at}` });
      }
    },

    lidEnded(why, detail) {
      const at = isoNow();
      deps.ring.push("lid_ended", { why, detail }, { at, key: `lid:${at}:${why}` });
    },

    warmupRan(run) {
      if (run.failed > 0) deps.ring.push("warmup_failed", { failed: run.failed, total: run.total }, { at: run.at, key: `warmup:${run.at}` });
    },
  };
}
