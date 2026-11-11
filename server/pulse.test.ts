import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Status, setMode, status, timerMinutes } from "../shared/caffeine.shared.ts";
import { OPERATIONS, describeCaffeine } from "./capabilities.server.ts";
import { createEventRing } from "./pulse-events.server.ts";
import {
  NOT_FOR_PULSE,
  PULSE_ACTIONS,
  PULSE_EVENT_TYPES,
  PULSE_METRICS,
  PULSE_SCHEMA,
  buildManifest,
  createPulse,
  pulseEventsRpc,
  pulseManifestRpc,
  pulseRev,
  pulseSnapshotRpc,
  pulseValues,
} from "./pulse.server.ts";
import { SKIP_NOT_SUBSCRIPTION } from "./warmup.server.ts";

/**
 * What Paseo Pulse sees of Caffeine is the manifest, the snapshot and the events feed, so these
 * tests hold them to the contract (paseo.pulse/1) and to the plugin itself: every action is a
 * real operation of meta.describe with the risk it has there, the readings come from the status
 * and nothing personal or ticking leaks into them, and the revisions move only when something
 * worth showing does. Where the Pulse repository sits next to this one, its own parser and its
 * reference copy of this manifest are used too.
 */

const PULSE_CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "paseo-pulse-plugin", "contract");
const pulseMissing = existsSync(join(PULSE_CONTRACT, "src", "manifest.ts")) ? false : "the Pulse repository is not next to this one";

type ParseManifest = (raw: unknown, pluginId: string, opts?: { checkAction?: (action: { operation?: string }) => string | null }) =>
  | { manifest: { metrics: unknown[]; actions: unknown[]; eventTypes: unknown[] }; dropped: unknown[] }
  | { fatal: string };

async function parseManifest(): Promise<ParseManifest> {
  const module = (await import(pathToFileURL(join(PULSE_CONTRACT, "src", "manifest.ts")).href)) as { parseManifest: ParseManifest };
  return module.parseManifest;
}

/** Pulse resolves `operation` against meta.describe; this is the part of that check Caffeine owns. */
const checkAction = (action: { operation?: string }) => {
  const op = describeCaffeine().operations.find((candidate) => candidate.id === action.operation);
  return op?.kind === "action" ? null : `no action ${action.operation} in meta.describe`;
};

const T0 = Date.parse("2026-11-08T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A status as the controller would hand it over, with something personal in every corner. */
function statusOf(patch: Record<string, unknown> = {}, thermal: Record<string, unknown> = {}): Status {
  return status.parse({
    mode: "timer",
    until: iso(T0 + 3_600_000),
    active: true,
    busy: true,
    agents: 2,
    tickAt: iso(T0),
    wakeUrl: "http://192.168.1.20:4242/wake",
    battery: { percent: 64, charging: false, charged: false, external: false, minutes: 210, adapterWatts: null, inputWatts: null, batteryWatts: -9.4 },
    lidClosed: true,
    lid: { on: true, until: iso(T0 + 3_600_000), minutes: 60, setup: "ready" },
    warmup: { enabled: true, nextAt: iso(T0 + 86_400_000), lastAt: iso(T0 - 3_600_000), results: [{ login: "roman@example.com (.claude)", ok: true }] },
    thermal: { pressure: 0, batteryC: 33.26, cpuC: 61.4, fans: [], lidClosed: false, armed: true, ...thermal },
    ...patch,
  });
}

function pulseRig(options: { status?: () => Status; settleMs?: number } = {}) {
  let clock = T0;
  let current = statusOf();
  const ring = createEventRing({ now: () => clock });
  const pulse = createPulse({ ring, status: options.status ?? (() => current), now: () => clock, settleMs: options.settleMs ?? 0 });
  return { pulse, ring, set: (next: Status) => void (current = next), advance: (ms: number) => void (clock += ms) };
}

const trip = (patch: Record<string, unknown> = {}) => ({ at: iso(T0 + 5_000), reason: "pressure", detail: "heavy for 60 s", dryRun: false, slept: null, holders: [], by: "plugin", ...patch });

test("the manifest is plain JSON that the daemon's shell lets through whole", () => {
  for (const shown of [true, false]) {
    const manifest = buildManifest(shown);
    assert.equal(manifest.schema, PULSE_SCHEMA);
    assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
    assert.deepEqual(pulseManifestRpc.output.parse(manifest), manifest);
    assert.ok(new TextEncoder().encode(JSON.stringify(manifest)).length < 64 * 1024, "under 64 KiB");
  }
  assert.equal(pulseManifestRpc.name, "meta.pulse");
  assert.ok(!pulseSnapshotRpc.name.startsWith("meta.") && !pulseEventsRpc.name.startsWith("meta."));
});

test("manifestRev is the hash of the rest: the same on every build, another one with Caffeine hidden", () => {
  const { manifestRev, ...body } = buildManifest(true);
  assert.equal(manifestRev, pulseRev(body));
  assert.match(manifestRev, /^r[A-Za-z0-9_-]{22}$/);
  assert.equal(buildManifest(true).manifestRev, manifestRev);
  assert.notEqual(buildManifest(false).manifestRev, manifestRev);
  // Key order and undefined keys do not matter, as for Pulse.
  assert.equal(pulseRev({ b: 1, a: [{ d: 2, c: undefined }] }), pulseRev({ a: [{ d: 2 }], b: 1 }));
});

test("Pulse's own parser keeps every metric, action and event type, shown or hidden", { skip: pulseMissing }, async () => {
  const parse = await parseManifest();
  for (const shown of [true, false]) {
    const parsed = parse(JSON.parse(JSON.stringify(buildManifest(shown))), "caffeine", { checkAction });
    assert.ok("manifest" in parsed, `not fatal: ${"fatal" in parsed ? parsed.fatal : ""}`);
    assert.deepEqual(parsed.dropped, [], `shown=${shown}`);
    assert.equal(parsed.manifest.metrics.length, shown ? 11 : 0);
    assert.equal(parsed.manifest.actions.length, PULSE_ACTIONS.length);
    assert.equal(parsed.manifest.eventTypes.length, PULSE_EVENT_TYPES.length);
  }
});

test("the manifest is Pulse's reference copy of it, but for the revision", { skip: pulseMissing }, () => {
  const reference = JSON.parse(readFileSync(join(PULSE_CONTRACT, "fixtures", "manifests", "caffeine.json"), "utf8")) as Record<string, unknown>;
  const { manifestRev: _ours, ...ours } = JSON.parse(JSON.stringify(buildManifest(true))) as Record<string, unknown>;
  const { manifestRev: _theirs, ...theirs } = reference;
  assert.deepEqual(ours, theirs);
});

test("ids, short labels and counts fit the contract's limits", () => {
  const local = /^[a-z][a-z0-9_]*$/;
  const texts = (text: unknown) => (typeof text === "string" ? [text] : Object.values(text as Record<string, string>));
  assert.ok(PULSE_METRICS.length <= 64 && PULSE_ACTIONS.length <= 32 && PULSE_EVENT_TYPES.length <= 32);
  for (const metric of PULSE_METRICS) {
    assert.match(metric.id, local);
    if ("short" in metric) for (const short of texts(metric.short)) assert.ok([...short].length <= 6, `${metric.id}: ${short}`);
    if ("states" in metric) {
      for (const [id, state] of Object.entries(metric.states)) {
        assert.match(id, local);
        if ("short" in state) for (const short of texts(state.short)) assert.ok([...short].length <= 6, `${metric.id}.${id}: ${short}`);
      }
    }
  }
  for (const action of PULSE_ACTIONS) {
    assert.match(action.id, local);
    for (const title of texts(action.title)) assert.ok([...title].length <= 24, `${action.id}: ${title}`);
    assert.ok((action.presets ?? []).length <= 6);
  }
  assert.equal(new Set(PULSE_METRICS.map((metric) => metric.id)).size, PULSE_METRICS.length);
  // Battery temperature and the lid are among the readings.
  for (const id of ["mode", "until", "hold", "lid", "battery", "battery_temp", "cpu", "heat", "heat_fires", "warmup", "warmup_next"]) {
    assert.ok(PULSE_METRICS.some((metric) => metric.id === id), id);
  }
});

test("every action of meta.describe is offered to Pulse or kept back with a reason, never both", () => {
  const actions = OPERATIONS.filter((op) => op.kind === "action").map((op) => op.id);
  const offered = PULSE_ACTIONS.map((action) => action.id);
  for (const id of actions) assert.ok(offered.includes(id) !== id in NOT_FOR_PULSE, `${id}: PULSE_ACTIONS or NOT_FOR_PULSE`);
  for (const id of [...offered, ...Object.keys(NOT_FOR_PULSE)]) assert.ok(actions.includes(id), `${id} is an action of meta.describe`);
  for (const [id, reason] of Object.entries(NOT_FOR_PULSE)) assert.ok(reason.length >= 20, `${id} says why`);
  for (const action of PULSE_ACTIONS) assert.equal(action.operation, action.id, "an action is the operation of the same id");
});

test("only low-risk actions with no confirmation start on; the ones that can let the Mac sleep start off", () => {
  const described = describeCaffeine().operations;
  for (const action of PULSE_ACTIONS) {
    const op = described.find((candidate) => candidate.id === action.operation);
    assert.ok(op?.risk && op.risk !== "destructive", action.id);
    assert.ok(op.method !== "caffeine.lid-setup" && !op.method.startsWith("settings.") && !op.method.startsWith("meta."), action.id);
    if (action.exposure === "on") assert.deepEqual([op.risk, op.confirm], ["low", "none"], action.id);
  }
  const on = (exposure: string) => PULSE_ACTIONS.filter((action) => action.exposure === exposure).map((action) => action.id);
  assert.deepEqual(on("on"), ["keep_awake", "keep_awake_for", "dismiss_heat_alert"]);
  assert.deepEqual(on("off"), ["lid_back_on", "allow_sleep", "auto", "sleep_now", "lid_off_now"]);
});

test("the timer's presets are exactly its lengths, and each reaches caffeine.set", () => {
  const timer = PULSE_ACTIONS.find((action) => action.id === "keep_awake_for");
  const op = OPERATIONS.find((candidate) => candidate.id === "keep_awake_for");
  assert.ok(timer?.presets && op);
  assert.deepEqual(timer.presets.map((preset) => preset.args.minutes).sort((a, b) => a - b), timerMinutes.options.map((option) => option.value));
  assert.deepEqual(timer.presets.slice(0, 2).map((preset) => preset.id), ["h1", "h2"], "the two most used first");
  for (const preset of timer.presets) {
    assert.doesNotThrow(() => op.input.parse(preset.args), preset.id);
    assert.doesNotThrow(() => setMode.input.parse({ ...preset.args, ...op.fixed }), preset.id);
  }
  for (const action of PULSE_ACTIONS.filter((candidate) => !candidate.presets)) {
    const described = OPERATIONS.find((candidate) => candidate.id === action.operation);
    assert.doesNotThrow(() => described?.input.parse({}), `${action.id} needs no argument`);
  }
});

test("hidden from Pulse: no readings, every action never, no buttons on the alerts", () => {
  const hidden = buildManifest(false);
  assert.deepEqual(hidden.metrics, []);
  for (const action of hidden.actions as Array<{ exposure: string }>) assert.equal(action.exposure, "never");
  for (const type of hidden.eventTypes as Array<{ actions?: string[] }>) assert.equal(type.actions, undefined);
  assert.deepEqual((hidden.eventTypes as Array<{ type: string }>).map((type) => type.type), PULSE_EVENT_TYPES.map((type) => type.type));
});

test("the readings come from the status, and nothing personal or ticking goes in", () => {
  const values = pulseValues(statusOf());
  assert.deepEqual(Object.keys(values), PULSE_METRICS.map((metric) => metric.id));
  const text = JSON.stringify(values);
  for (const leak of ["@", "http", "192.168", iso(T0), "210", "-9.4"]) assert.ok(!text.includes(leak), `no ${leak} in ${text}`);
  assert.deepEqual(values.mode, { state: "timer" });
  assert.deepEqual(values.until, { at: iso(T0 + 3_600_000) });
  assert.deepEqual(values.hold, { state: "held" });
  assert.deepEqual(values.lid, { state: "on" });
  assert.deepEqual(values.battery, { value: 64 });
  assert.deepEqual(values.battery_temp, { value: 33.5 });
  assert.deepEqual(values.cpu, { value: 61 });
  assert.deepEqual(values.heat, { state: "normal" });
  assert.deepEqual(values.heat_fires, { availability: "empty" });
  assert.deepEqual(values.warmup, { state: "on" });
  assert.deepEqual(values.warmup_next, { at: iso(T0 + 86_400_000) });
});

test("every state reading is one of its metric's states", () => {
  const cases = [
    statusOf(),
    statusOf({ mode: "off", until: "", active: false, lid: { on: false }, battery: null, warmup: { enabled: false } }, { batteryC: null, cpuC: null, sensors: "no helper" }),
    statusOf({ mode: "auto", busy: true, active: false, error: "caffeinate exited" }, { state: "pending", pendingReason: "pressure", firesAt: iso(T0 + 30_000), simulated: true }),
    statusOf({ mode: "on", active: false, lid: { on: false, error: "cooling" } }, { state: "latched", lidClosed: null, latch: trip() }),
    statusOf({ warmup: { enabled: true, running: true } }, { state: "blind", firesAt: iso(T0 + 90_000) }),
    statusOf({ warmup: { enabled: true, results: [{ login: "a@x", ok: false, error: "rate limited" }] } }, { state: "warm" }),
  ];
  for (const s of cases) {
    const values = pulseValues(s) as Record<string, { state?: string }>;
    for (const metric of PULSE_METRICS) {
      if (!("states" in metric)) continue;
      assert.ok(values[metric.id]?.state && values[metric.id]?.state as string in metric.states, `${metric.id}: ${values[metric.id]?.state}`);
    }
  }
});

test("hold, lid, heat and warm-up say what the guard and the switches do", () => {
  // A timer with the lid switch on, lid mode refused while the Mac cools down, the hold off.
  const latched = pulseValues(statusOf({ mode: "timer", active: false, lid: { on: false, error: "cooling" } }, { state: "latched", lidClosed: true, latch: trip(), coolAt: iso(T0 + 300_000) }));
  assert.equal((latched.hold as { state: string }).state, "suspended");
  assert.deepEqual(latched.lid, { state: "blocked", note: `the heat guard keeps it off until the Mac has cooled down (about ${iso(T0 + 300_000)})` });
  assert.deepEqual(latched.heat, { state: "latched" });
  // Off, with the switch on: nothing wants lid mode, so it is plain off.
  assert.deepEqual(pulseValues(statusOf({ mode: "off", active: false, lid: { on: false } })).lid, { state: "off" });
  // A failed hold, a pending trip on simulated readings, a desktop Mac without a battery.
  const pending = pulseValues(statusOf({ error: "caffeinate exited", battery: null }, { state: "pending", pendingReason: "pressure", firesAt: iso(T0 + 30_000), simulated: true, cpuC: null, sensors: "no helper" }));
  assert.deepEqual(pending.hold, { state: "failed", note: "caffeinate exited" });
  assert.deepEqual(pending.heat, { state: "pending", note: "pressure; simulated" });
  assert.deepEqual(pending.heat_fires, { at: iso(T0 + 30_000) });
  assert.deepEqual(pending.battery_temp, { value: 33.5, note: "simulated" });
  assert.deepEqual(pending.cpu, { availability: "unavailable", note: "no helper" });
  assert.deepEqual(pending.battery, { availability: "unavailable", note: "no battery" });
  // A skipped API login is not a failed warm-up; a real failure is.
  assert.deepEqual(pulseValues(statusOf({ warmup: { enabled: true, results: [{ login: "a@x", ok: false, error: SKIP_NOT_SUBSCRIPTION }] } })).warmup, { state: "on" });
  assert.deepEqual(pulseValues(statusOf({ warmup: { enabled: true, results: [{ login: "a@x", ok: false, error: "rate limited" }] } })).warmup, { state: "failed" });
  // On the charger, the battery says so.
  assert.deepEqual(pulseValues(statusOf({ battery: { percent: 100, charging: false, charged: true, external: true, minutes: null } })).battery, { value: 100, note: "charged" });
});

test("rev moves with what is shown, not with what ticks; ifRev answers unchanged", async () => {
  const r = pulseRig();
  r.pulse.setShown(true);
  r.pulse.started(true);
  const first = await r.pulse.snapshot({});
  assert.deepEqual(pulseSnapshotRpc.output.parse(first), first, "the daemon's shell lets it through whole");
  assert.equal(first.asOf, iso(T0), "as of the controller's tick");
  assert.deepEqual(first.events, { head: "" });
  const { rev } = first;
  assert.equal((await r.pulse.snapshot({})).rev, rev);

  // What ticks or is personal: the tick, the wake link, agents, the battery's minutes, emails.
  r.set(statusOf({ tickAt: iso(T0 + 30_000), wakeUrl: "http://10.0.0.2/wake", agents: 5, battery: { percent: 64, charging: false, charged: false, external: false, minutes: 12 }, warmup: { enabled: true, nextAt: iso(T0 + 86_400_000), results: [{ login: "other@example.com", ok: true }] } }));
  r.advance(30_000);
  const ticked = await r.pulse.snapshot({});
  assert.equal(ticked.rev, rev);
  assert.notEqual(ticked.asOf, first.asOf);
  assert.deepEqual(await r.pulse.snapshot({ ifRev: rev }), { schema: PULSE_SCHEMA, unchanged: true, rev, manifestRev: first.manifestRev, asOf: iso(T0 + 30_000) });

  // What is shown: the mode, the battery, a new event, the switch.
  r.set(statusOf({ battery: { percent: 63, charging: false, charged: false, external: false, minutes: 200 } }));
  const battery = await r.pulse.snapshot({ ifRev: rev });
  assert.notEqual(battery.rev, rev);
  assert.equal(battery.unchanged, undefined);
  r.set(statusOf({ mode: "on", until: "" }));
  assert.notEqual((await r.pulse.snapshot({})).rev, battery.rev);
  const before = await r.pulse.snapshot({});
  r.pulse.lidEnded("battery", "battery at 15%");
  const after = await r.pulse.snapshot({});
  assert.notEqual(after.rev, before.rev);
  assert.deepEqual(after.events, { head: r.pulse.events({}).head });
  r.pulse.setShown(false);
  const hidden = await r.pulse.snapshot({});
  assert.notEqual(hidden.rev, after.rev);
  assert.deepEqual(hidden.values, {});
  assert.equal(hidden.manifestRev, buildManifest(false).manifestRev);
});

test("before the start chain is through every reading is empty, and after a failed start an error", async () => {
  const r = pulseRig({ status: () => statusOf({ mode: "off" }) });
  r.pulse.setShown(true);
  const starting = await r.pulse.snapshot({});
  const values = starting.values as Record<string, { availability?: string; state?: string }>;
  assert.deepEqual(Object.keys(values), PULSE_METRICS.map((metric) => metric.id));
  for (const reading of Object.values(values)) assert.deepEqual(reading, { availability: "empty", note: "starting" });
  r.pulse.started(false);
  const failed = await r.pulse.snapshot({});
  for (const reading of Object.values(failed.values as Record<string, unknown>)) assert.deepEqual(reading, { availability: "error", note: "Caffeine did not start" });
  assert.notEqual(failed.rev, starting.rev);
});

test("the manifest waits for the first read of the settings, so a hidden Caffeine never shows", async () => {
  const r = pulseRig({ settleMs: 60_000 });
  let answered = false;
  const pending = r.pulse.manifest().then((manifest) => ((answered = true), manifest));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false);
  r.pulse.setShown(false);
  assert.equal((await pending).manifestRev, buildManifest(false).manifestRev);
  const unread = pulseRig({ settleMs: 60_000 });
  unread.pulse.settingsUnavailable();
  assert.equal((await unread.pulse.manifest()).manifestRev, buildManifest(true).manifestRev, "no settings: shown");
  const late = pulseRig({ settleMs: 5 });
  assert.equal((await late.pulse.manifest()).manifestRev, buildManifest(true).manifestRev, "no read in time: shown");
});

test("a trip is one event however many looks see it; a dry run is info; a sleep that did not take is its own alert", () => {
  const r = pulseRig();
  const thermal = (event: ReturnType<typeof trip> | null, latch: ReturnType<typeof trip> | null = null) => statusOf({}, { event, latch }).thermal;
  r.pulse.heatSeen(thermal(null));
  r.pulse.heatSeen(thermal(trip({ slept: null }), trip({ slept: null })));
  r.pulse.heatSeen(thermal(trip({ slept: null }), trip({ slept: null })));
  r.pulse.heatSeen(thermal(trip({ slept: false, holders: ["Amphetamine"] }), trip({ slept: false, holders: ["Amphetamine"] })));
  // Dismissed: the banner goes, the latch stays; still the same trip.
  r.pulse.heatSeen(thermal(null, trip({ slept: false, holders: ["Amphetamine"] })));
  r.pulse.heatSeen(thermal(trip({ at: iso(T0 + 60_000), dryRun: true, reason: "fans", by: "guard" })));
  const page = r.pulse.events({});
  assert.deepEqual(pulseEventsRpc.output.parse(page), page, "the daemon's shell lets it through whole");
  assert.deepEqual(
    page.events.map((event) => [event.type, event.fields]),
    [
      ["heat_trip", { reason: "pressure", detail: "heavy for 60 s", by: "plugin" }],
      ["heat_sleep_failed", { reason: "pressure", detail: "heavy for 60 s", by: "plugin", holders: "Amphetamine" }],
      ["heat_trip_dry", { reason: "fans", detail: "heavy for 60 s", by: "guard" }],
    ],
  );
  assert.equal(page.events[0]?.at, iso(T0 + 5_000), "when it happened");
  for (const event of page.events) {
    const declared = PULSE_EVENT_TYPES.find((type) => type.type === event.type);
    assert.ok(declared, event.type);
    assert.deepEqual(Object.keys(event.fields ?? {}).sort(), Object.keys(declared.fields).sort(), `${event.type} sends its declared fields`);
  }
  assert.deepEqual(page.schema, PULSE_SCHEMA);
});

test("a trip left in the latch file from before this process is not news", () => {
  const r = pulseRig();
  r.pulse.heatSeen(statusOf({}, { latch: trip({ at: iso(T0 - 3_600_000) }) }).thermal);
  assert.deepEqual(r.pulse.events({}).events, []);
});

test("lid mode's own ends and failed warm-ups are events; a warm-up with no failure is none", () => {
  const r = pulseRig();
  r.pulse.lidEnded("battery", "battery at 15%");
  r.advance(1_000);
  r.pulse.lidEnded("manual", "sleep was switched back on by hand");
  r.pulse.warmupRan({ at: iso(T0), total: 2, failed: 0 });
  r.pulse.warmupRan({ at: iso(T0 + 1), total: 2, failed: 1 });
  r.pulse.warmupRan({ at: iso(T0 + 1), total: 2, failed: 1 });
  assert.deepEqual(
    r.pulse.events({}).events.map((event) => [event.type, event.fields]),
    [
      ["lid_ended", { why: "battery", detail: "battery at 15%" }],
      ["lid_ended", { why: "manual", detail: "sleep was switched back on by hand" }],
      ["warmup_failed", { failed: 1, total: 2 }],
    ],
  );
});
