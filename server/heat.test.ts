import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HeatDeps, createHeat, fileLatch, fileLock } from "./heat.server.ts";
import type { Reading } from "./sensors.server.ts";

const T0 = Date.parse("2026-10-24T02:00:00Z");
const S = 1000;

/** The orchestrator against stand-in sensors and actions, with real files in a temp dir. */
function rig(options: { dryRunFile?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "caffeine-heat-"));
  const files = { latch: join(dir, "latch"), lock: join(dir, "lock"), dryRun: join(dir, "dryrun"), conf: join(dir, "thermal.conf") };
  if (options.dryRunFile) writeFileSync(files.dryRun, "");
  let clock = T0;
  let armed = true;
  let reading: Reading = { pressure: 0, batteryC: 31, cpuC: 44, fans: [], lidClosed: true, sensors: "", simulated: false };
  const calls: string[] = [];
  const latch = fileLatch(files.latch);
  const deps: HeatDeps = {
    sensors: { read: async () => ({ ...reading }), helper: () => "/opt/caffeine-sensors-1" },
    armed: () => armed,
    files,
    emergency: async (trip, dryRun) => {
      calls.push(`emergency ${trip.reason}${dryRun ? " (dry)" : ""}`);
      const record = { at: Math.round(clock / 1000), reason: trip.reason, detail: trip.detail, dryRun, slept: dryRun ? null : true, holders: [], by: "plugin", dismissed: false };
      await latch.write(record);
      return record;
    },
    endForHeat: async () => (calls.push("endForHeat"), true),
    resleep: async () => void calls.push("resleep"),
    now: () => clock,
  };
  const heat = createHeat(deps);
  return {
    heat,
    files,
    calls,
    set: (next: Partial<Reading>) => void (reading = { ...reading, ...next }),
    arm: (value: boolean) => void (armed = value),
    advance: (ms: number) => void (clock += ms),
    /** Ticks every 15 s, `count` times. */
    tick: async (count = 1) => {
      for (let i = 0; i < count; i += 1) {
        await heat.tick();
        clock += 15 * S;
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("heavy for 60 s: one emergency, then latched, the hold suspended with the lid closed", async () => {
  const r = rig();
  try {
    r.set({ pressure: 2 });
    await r.tick(4);
    assert.equal(r.calls.length, 0);
    await r.tick(1);
    assert.deepEqual(r.calls, ["emergency pressure"]);
    const status = r.heat.status();
    assert.equal(status.state, "latched");
    assert.equal(status.latch?.reason, "pressure");
    assert.equal(r.heat.latched(), true);
    assert.equal(r.heat.holdSuspended(), true);
    r.set({ lidClosed: false });
    await r.tick();
    assert.equal(r.heat.holdSuspended(), false, "the lid open: somebody is at the Mac");
    await r.tick(10);
    assert.equal(r.calls.filter((call) => call.startsWith("emergency")).length, 1, "a latch is not tripped again");
  } finally {
    r.cleanup();
  }
});

test("the dry-run switch: the trip is recorded as dry, nothing is suspended, and it fires once per spell", async () => {
  const r = rig({ dryRunFile: true });
  try {
    r.set({ pressure: 3 });
    await r.tick(3);
    assert.deepEqual(r.calls, ["emergency trapping (dry)"]);
    const status = r.heat.status();
    assert.equal(status.dryRun, true);
    assert.equal(status.latch, null, "a dry record is not a latch");
    assert.equal(status.event?.dryRun, true, "but the page shows it");
    assert.equal(r.heat.holdSuspended(), false);
    assert.equal(r.heat.latched(), false);
    assert.equal(await r.heat.gate(), "ok", "lid mode is not locked out by a dry run");
    await r.heat.dismiss();
    assert.equal(existsSync(r.files.latch), false);
    await r.tick();
    assert.deepEqual(r.calls, ["emergency trapping (dry)", "emergency trapping (dry)"], "after dismissing, the next spell is told again");
  } finally {
    r.cleanup();
  }
});

test("simulated readings are dry even without the switch", async () => {
  const r = rig();
  try {
    r.set({ pressure: 3, simulated: true });
    await r.tick();
    assert.deepEqual(r.calls, ["emergency trapping (dry)"]);
    assert.equal(r.heat.status().simulated, true);
  } finally {
    r.cleanup();
  }
});

test("nothing trips with lid mode off", async () => {
  const r = rig();
  try {
    r.arm(false);
    r.set({ pressure: 3, batteryC: 47 });
    await r.tick(10);
    assert.deepEqual(r.calls, []);
    assert.equal(r.heat.status().state, "warm");
  } finally {
    r.cleanup();
  }
});

test("a real latch: back to sleep once a minute with the lid closed, lid mode switched off if it came back", async () => {
  const r = rig();
  try {
    r.set({ batteryC: 46 });
    await r.tick(2);
    assert.deepEqual(r.calls, ["emergency battery"]);
    r.calls.length = 0;
    r.arm(false);
    await r.tick(8); // two minutes, lid closed
    assert.equal(r.calls.filter((call) => call === "resleep").length, 2);
    r.set({ lidClosed: false });
    r.calls.length = 0;
    await r.tick(8);
    assert.deepEqual(r.calls, [], "lid open: left awake");
    r.arm(true);
    await r.tick();
    assert.deepEqual(r.calls, ["endForHeat"], "lid mode back on under a latch: off again");
  } finally {
    r.cleanup();
  }
});

test("lid mode is refused until the Mac has been cool for the whole cool-down, then the latch goes", async () => {
  const r = rig();
  try {
    r.set({ pressure: 3 });
    await r.tick();
    r.arm(false);
    assert.equal(await r.heat.gate(), "cooling");
    r.set({ pressure: 0, batteryC: 37, lidClosed: false });
    await r.tick(12); // 0 … 165 s cool
    assert.equal(await r.heat.gate(), "cooling");
    r.set({ batteryC: 39 }); // too warm: starts over
    await r.tick();
    r.set({ batteryC: 37 });
    await r.tick(20); // 0 … 285 s cool
    assert.equal(await r.heat.gate(), "cooling");
    assert.ok(r.heat.status().coolAt !== "");
    await r.tick(2); // 300 s and over
    assert.equal(r.heat.status().cool, true);
    assert.equal(await r.heat.gate(), "ok");
    assert.equal(existsSync(r.files.latch), false);
    assert.equal(r.heat.latched(), false);
  } finally {
    r.cleanup();
  }
});

test("dismissing a real latch hides the banner and keeps the lockout", async () => {
  const r = rig();
  try {
    r.set({ pressure: 3 });
    await r.tick();
    await r.heat.dismiss();
    assert.equal(r.heat.status().event, null);
    assert.equal(r.heat.latched(), true);
    assert.equal(await r.heat.gate(), "cooling");
  } finally {
    r.cleanup();
  }
});

test("settings: normalised from the host's values, and written for the guard with the helper's path", async () => {
  const r = rig();
  try {
    r.heat.setStored({ thermalPressure: "moderate", thermalDelayS: 30, fanPct: 70, fanDelayS: 120 });
    await r.tick();
    const status = r.heat.status();
    assert.equal(status.settings.pressure, "moderate");
    assert.equal(status.settings.delayS, 300, "30 s is heavy's: moderate's default instead");
    const conf = readFileSync(r.files.conf, "utf8");
    assert.match(conf, /^PRESSURE_LEVEL=1$/m);
    assert.match(conf, /^PRESSURE_DELAY=300$/m);
    assert.match(conf, /^FAN_PCT=70$/m);
    assert.match(conf, /^HELPER=\/opt\/caffeine-sensors-1$/m);
  } finally {
    r.cleanup();
  }
});

test("a pending trigger shows when it fires", async () => {
  const r = rig();
  try {
    r.set({ pressure: 2 });
    await r.tick(2);
    const status = r.heat.status();
    assert.equal(status.state, "pending");
    assert.equal(status.pendingReason, "pressure");
    assert.equal(status.firesAt, new Date(T0 + 60 * S).toISOString());
  } finally {
    r.cleanup();
  }
});

test("the lock: one holder at a time, and one left by a crash is taken over after five minutes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caffeine-lock-"));
  try {
    let now = Date.now();
    const lock = fileLock(join(dir, "lock"), () => now);
    assert.equal(await lock.take(), true);
    assert.equal(await lock.take(), false);
    now += 6 * 60_000;
    assert.equal(await lock.take(), true, "stale");
    await lock.release();
    assert.equal(existsSync(join(dir, "lock")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two writes of the same file at once both land (a settings change racing a tick)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caffeine-race-"));
  try {
    const latch = fileLatch(join(dir, "latch"));
    const record = { at: 1, reason: "battery" as const, detail: "", dryRun: true, slept: null, holders: [], by: "plugin", dismissed: false };
    await Promise.all([latch.write(record), latch.write({ ...record, detail: "second" }), latch.write({ ...record, detail: "third" })]);
    assert.ok((await latch.read()) !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a simulation can pretend lid mode is on, and is still only a dry run", async () => {
  const r = rig();
  try {
    r.arm(false);
    r.set({ pressure: 2, simulated: true, armed: true });
    await r.tick(5);
    assert.deepEqual(r.calls, ["emergency pressure (dry)"]);
    assert.equal(r.heat.status().armed, true);
    assert.equal(r.heat.holdSuspended(), false);
  } finally {
    r.cleanup();
  }
});
