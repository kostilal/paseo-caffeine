import { test } from "node:test";
import assert from "node:assert/strict";
import type { FanReading } from "../shared/caffeine.shared.ts";
import {
  BLIND_MS,
  DEFAULT_THERMAL,
  coolSince,
  createThermalEvaluator,
  fanMinPct,
  formatGuardConf,
  formatLatch,
  normalizeThermal,
  parseLatch,
  type ThermalSample,
} from "./thermal.ts";

const T0 = Date.parse("2026-10-24T02:00:00Z");
const S = 1000;
/** A two-fan 16-inch M4 Pro: 2317 rpm floor, 7826 rpm top. */
const fans = (rpm: number, other = rpm): FanReading[] => [
  { rpm, min: 2317, max: 7826, manual: false },
  { rpm: other, min: 2317, max: 7826, manual: false },
];

/** A closed, armed Mac at rest; each test changes what it is about. */
function sample(overrides: Partial<ThermalSample> & { at: number }): ThermalSample {
  return { pressure: 0, batteryC: 31, fans: fans(2320), lidClosed: true, armed: true, ...overrides };
}

/** Feeds readings every 15 s from T0 and returns the first trip, with when it came. */
function runUntilTrip(readings: Array<Partial<ThermalSample>>, settings = DEFAULT_THERMAL) {
  const guard = createThermalEvaluator();
  for (const [index, reading] of readings.entries()) {
    const at = T0 + index * 15 * S;
    const { trip, view } = guard.observe(sample({ ...reading, at }), settings);
    if (trip) return { trip, at, view, index };
  }
  return null;
}

const repeat = <T>(times: number, value: T): T[] => Array.from({ length: times }, () => value);

test("a Mac at rest stays normal and never trips", () => {
  const guard = createThermalEvaluator();
  for (let i = 0; i < 40; i += 1) {
    const { view, trip } = guard.observe(sample({ at: T0 + i * 15 * S }), DEFAULT_THERMAL);
    assert.equal(trip, null);
    assert.equal(view.state, "normal");
  }
});

test("trapping and sleeping put the Mac to sleep on the first reading", () => {
  assert.equal(runUntilTrip([{ pressure: 3 }])?.trip.reason, "trapping");
  assert.equal(runUntilTrip([{ pressure: 4 }])?.trip.reason, "trapping");
});

test("heavy trips once it has held for the delay, not before", () => {
  const hit = runUntilTrip(repeat(10, { pressure: 2 }));
  assert.equal(hit?.trip.reason, "pressure");
  assert.equal(hit?.at, T0 + 60 * S, "60 s after the first heavy reading");
});

test("heavy that drops back to nominal starts over", () => {
  const readings = [...repeat(3, { pressure: 2 }), { pressure: 0 }, ...repeat(4, { pressure: 2 })];
  const hit = runUntilTrip(readings);
  assert.equal(hit, null, "30 s, a break, then 45 s: neither run reached 60 s");
});

test("an unreadable pressure neither starts nor breaks a heavy run", () => {
  const readings = [{ pressure: 2 }, { pressure: 2 }, { pressure: null }, { pressure: 2 }, { pressure: 2 }];
  assert.equal(runUntilTrip(readings)?.at, T0 + 60 * S);
});

test("moderate trips after its own delay, and heavy under it still within 60 s", () => {
  const moderate = normalizeThermal({ thermalPressure: "moderate", thermalDelayS: 300 });
  assert.equal(runUntilTrip(repeat(30, { pressure: 1 }), moderate)?.at, T0 + 300 * S);
  assert.equal(runUntilTrip(repeat(30, { pressure: 2 }), moderate)?.at, T0 + 60 * S, "heavy caps at 60 s");
  const heavySlow = normalizeThermal({ thermalPressure: "heavy", thermalDelayS: 120 });
  assert.equal(runUntilTrip(repeat(30, { pressure: 1 }), heavySlow), null, "moderate is ignored under heavy");
  assert.equal(runUntilTrip(repeat(30, { pressure: 2 }), heavySlow)?.at, T0 + 120 * S);
});

test("the battery trips at 45 °C on the second reading in a row, and a cooler one resets it", () => {
  const hit = runUntilTrip([{ batteryC: 44.9 }, { batteryC: 45 }, { batteryC: 45.2 }]);
  assert.equal(hit?.trip.reason, "battery");
  assert.equal(hit?.index, 2);
  assert.equal(runUntilTrip([{ batteryC: 45 }, { batteryC: 44 }, { batteryC: 45 }, { batteryC: 30 }]), null);
  assert.equal(runUntilTrip([{ batteryC: 45 }, { batteryC: null }, { batteryC: 45.5 }])?.index, 2, "a missing reading does not reset");
});

test("no readings at all with the lid closed sleeps after 90 s; with the lid open it never does", () => {
  const blind = { pressure: null, batteryC: null };
  const hit = runUntilTrip(repeat(10, blind));
  assert.equal(hit?.trip.reason, "blind");
  assert.equal(hit?.at, T0 + BLIND_MS);
  assert.equal(runUntilTrip(repeat(20, { ...blind, lidClosed: false })), null);
  // One sensor is enough to see: a missing pressure with a readable battery is not blind.
  assert.equal(runUntilTrip(repeat(20, { pressure: null })), null);
  // Readings coming back in time call it off.
  assert.equal(runUntilTrip([...repeat(5, blind), {}, ...repeat(5, blind)]), null);
});

test("the fans trip with the lid closed at the threshold for the delay, against each fan's own maximum", () => {
  const busy = { fans: fans(6800, 2320) }; // one fan at 87 %
  const hit = runUntilTrip(repeat(10, busy));
  assert.equal(hit?.trip.reason, "fans");
  assert.equal(hit?.at, T0 + 60 * S);
  assert.equal(runUntilTrip(repeat(20, { ...busy, lidClosed: false })), null, "the lid open: not this trigger");
  assert.equal(runUntilTrip(repeat(20, { fans: fans(6400) })), null, "82 %: under 85 %");
});

test("a fan dip inside the 10-point band keeps the run, a deeper one ends it", () => {
  const high = { fans: fans(6800) }; // 87 %
  const band = { fans: fans(6000) }; // 77 %: under 85, over 75
  const low = { fans: fans(5500) }; // 70 %
  assert.equal(runUntilTrip([high, high, band, high, high])?.at, T0 + 60 * S);
  assert.equal(runUntilTrip([high, high, low, high, high]), null);
});

test("no fans or unreadable fans never trip, and are not blindness", () => {
  assert.equal(runUntilTrip(repeat(20, { fans: [] })), null);
  assert.equal(runUntilTrip(repeat(20, { fans: null })), null);
});

test("nothing trips while lid mode is off, but the page still says warm", () => {
  const guard = createThermalEvaluator();
  for (let i = 0; i < 10; i += 1) {
    const { trip, view } = guard.observe(sample({ at: T0 + i * 15 * S, armed: false, pressure: 3, batteryC: 46 }), DEFAULT_THERMAL);
    assert.equal(trip, null);
    assert.equal(view.state, "warm");
  }
});

test("a running trigger shows as pending with when it fires", () => {
  const guard = createThermalEvaluator();
  guard.observe(sample({ at: T0, pressure: 2 }), DEFAULT_THERMAL);
  const { view, trip } = guard.observe(sample({ at: T0 + 15 * S, pressure: 2 }), DEFAULT_THERMAL);
  assert.equal(trip, null);
  assert.equal(view.state, "pending");
  assert.equal(view.pendingReason, "pressure");
  assert.equal(view.firesAt, T0 + 60 * S);
  const blind = createThermalEvaluator();
  const seen = blind.observe(sample({ at: T0, pressure: null, batteryC: null }), DEFAULT_THERMAL).view;
  assert.equal(seen.state, "blind");
  assert.equal(seen.firesAt, T0 + BLIND_MS);
});

test("reset forgets every run", () => {
  const guard = createThermalEvaluator();
  for (let i = 0; i < 3; i += 1) guard.observe(sample({ at: T0 + i * 15 * S, pressure: 2 }), DEFAULT_THERMAL);
  guard.reset();
  assert.equal(guard.observe(sample({ at: T0 + 61 * S, pressure: 2 }), DEFAULT_THERMAL).trip, null);
});

test("the cool-down needs the battery at 38 °C and the pressure nominal without a break", () => {
  let since: number | null = null;
  since = coolSince(since, { at: T0, pressure: 0, batteryC: 38 });
  assert.equal(since, T0);
  since = coolSince(since, { at: T0 + 60 * S, pressure: 0, batteryC: 37 });
  assert.equal(since, T0, "keeps the start");
  assert.equal(coolSince(since, { at: T0 + 90 * S, pressure: 1, batteryC: 30 }), null, "moderate breaks it");
  assert.equal(coolSince(since, { at: T0 + 90 * S, pressure: 0, batteryC: 39 }), null, "too warm breaks it");
  assert.equal(coolSince(since, { at: T0 + 90 * S, pressure: 0, batteryC: null }), null, "an unreadable battery is not cool");
  assert.equal(coolSince(null, { at: T0, pressure: null, batteryC: 30 }), T0, "no pressure published: the battery decides");
});

test("settings land on something safe: delays per level, the fan grid and floor, defaults for garbage", () => {
  assert.deepEqual(normalizeThermal({}), DEFAULT_THERMAL);
  assert.equal(normalizeThermal({ thermalPressure: "heavy", thermalDelayS: 600 }).delayS, 60, "600 s is moderate's, not heavy's");
  assert.equal(normalizeThermal({ thermalPressure: "moderate", thermalDelayS: 30 }).delayS, 300, "30 s is heavy's");
  assert.equal(normalizeThermal({ thermalPressure: "trapping" }).pressure, "heavy");
  assert.equal(normalizeThermal({ thermalCooldownMin: 7 }).cooldownMin, 5);
  assert.equal(normalizeThermal({ fanPct: 87 }).fanPct, 85, "onto the 5 % grid");
  assert.equal(normalizeThermal({ fanPct: 120 }).fanPct, 95);
  assert.equal(normalizeThermal({ fanPct: 10 }, fans(2320)).fanPct, 40, "never under the fans' floor plus 10");
  assert.equal(normalizeThermal({ fanPct: "loud" }).fanPct, 85);
  assert.equal(normalizeThermal({ fanDelayS: 1 }).fanDelayS, 60);
});

test("the fan floor comes from the machine: 40 % on 2317 / 7826, 35 % on a 1000 / 4900 mini", () => {
  assert.equal(fanMinPct(fans(2320)), 40);
  assert.equal(fanMinPct([{ rpm: 1000, min: 1000, max: 4900, manual: false }]), 35);
  assert.equal(fanMinPct([{ rpm: 0, min: 0, max: 6000, manual: false }]), 10, "a fan that can stop");
  assert.equal(fanMinPct(null), 40);
  assert.equal(fanMinPct([]), 40);
});

test("the latch file round-trips, and the guard's appended lines win", () => {
  const record = { at: 1792794840, reason: "pressure" as const, detail: "Heavy 60 s", dryRun: false, slept: null, holders: [], by: "plugin", dismissed: false };
  assert.deepEqual(parseLatch(formatLatch(record)), record);
  const appended = `${formatLatch(record)}slept=0\nholders=caffeinate coreaudiod\n`;
  assert.deepEqual(parseLatch(appended)?.holders, ["caffeinate", "coreaudiod"]);
  assert.equal(parseLatch(appended)?.slept, false);
  assert.equal(parseLatch("reason=battery\n"), null, "no time, no latch");
  assert.equal(parseLatch("at=1\nreason=lava\n"), null, "an unknown reason is not trusted");
  assert.ok(!formatLatch({ ...record, detail: "a\nholders=evil" }).includes("\nholders=evil"), "no line can be smuggled in");
});

test("the guard's settings file is numbers and one checked path", () => {
  const conf = formatGuardConf(normalizeThermal({ thermalPressure: "moderate", thermalDelayS: 120, fanPct: 70, fanDelayS: 30 }), "/x/bin/caffeine-sensors-1\nrm -rf /");
  assert.match(conf, /^PRESSURE_LEVEL=1$/m);
  assert.match(conf, /^PRESSURE_DELAY=120$/m);
  assert.match(conf, /^FAN_PCT=70$/m);
  assert.match(conf, /^FAN_DELAY=30$/m);
  assert.equal(conf.split("\n").filter((line) => line.startsWith("HELPER=")).length, 1);
  assert.ok(!/^rm /m.test(conf));
});
