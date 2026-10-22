import { test } from "node:test";
import assert from "node:assert/strict";
import { createController } from "./controller.server.ts";
import type { Keeper } from "./keeper.server.ts";
import type { Stored } from "./policy.ts";
import type { LidStatus } from "../shared/caffeine.shared.ts";
import { GRACE_MS } from "./policy.ts";

/** Lid mode as the controller sees it: what was asked of it, and the status that follows. */
function fakeLid(delayMs = 0) {
  const calls: string[] = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  let state: LidStatus = { on: false, until: "", minutes: 0, forever: false, ended: "", stopped: "", setup: "ready", error: "" };
  return {
    calls,
    tick: async () => undefined,
    status: () => state,
    enable: async (length: number | "forever", untilMs?: number) => {
      // Switching lid mode takes real time (sudo, pmset); the state lands at the end.
      if (delayMs > 0) await pause();
      calls.push(length === "forever" ? "forever" : `until ${new Date(untilMs ?? 0).toISOString()}`);
      state = length === "forever"
        ? { ...state, on: true, forever: true, until: "", minutes: 0 }
        : { ...state, on: true, forever: false, until: new Date(untilMs ?? 0).toISOString(), minutes: length };
    },
    disable: async (why: string) => {
      calls.push(`off: ${why}`);
      state = { ...state, on: false, forever: false, until: "", minutes: 0 };
    },
    /** Lid mode ending by itself, the way a low battery ends it. */
    endByItself: () => {
      state = { ...state, on: false, forever: false, until: "", minutes: 0, ended: "battery" };
    },
  };
}

function fakes(initial: Stored, running: () => number | null, lid?: ReturnType<typeof fakeLid>) {
  let stored = initial;
  const writes: Stored[] = [];
  const held: Array<number | undefined> = [];
  const heldDisplay: boolean[] = [];
  let releases = 0;
  let active = false;
  let clock = Date.parse("2026-09-09T18:00:00.000Z");
  let wakeUrl = "";
  let sleepCalls = 0;
  const keeper: Keeper = {
    active: () => active,
    error: () => "",
    pid: () => (active ? 1 : null),
    hold: (until, keepDisplay = false) => {
      active = true;
      held.push(until);
      heldDisplay.push(keepDisplay);
    },
    release: () => {
      if (active) releases += 1;
      active = false;
    },
  };
  const controller = createController({
    read: async () => stored,
    write: async (next) => {
      stored = next;
      writes.push(next);
    },
    keeper,
    runningCount: async () => running(),
    wakeUrl: () => wakeUrl,
    sleepNow: () => {
      sleepCalls += 1;
    },
    now: () => clock,
    tickMs: 60 * 60_000, // never fires during a test
    lid,
  });
  return {
    controller,
    keeper,
    writes,
    held,
    heldDisplay,
    releaseCount: () => releases,
    sleepCount: () => sleepCalls,
    setWakeUrl: (url: string) => (wakeUrl = url),
    advance: (ms: number) => (clock += ms),
    get stored() {
      return stored;
    },
  };
}

test("start restores a stored 'on' and holds at once", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  assert.equal(f.controller.status().mode, "on");
  f.controller.stop();
  assert.equal(f.keeper.active(), false);
});

test("set timer writes the deadline and holds with it", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "timer", minutes: 180 });
  assert.equal(status.mode, "timer");
  assert.equal(status.until, "2026-09-09T21:00:00.000Z");
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T21:00:00.000Z"));
  assert.equal(f.stored.mode, "timer");
  f.controller.stop();
});

test("a tick past the deadline turns the timer off and releases", async () => {
  const f = fakes({ mode: "timer", until: "2026-09-09T18:00:30.000Z", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  f.advance(31_000);
  const status = await f.controller.tick();
  assert.equal(status.mode, "off");
  assert.equal(status.active, false);
  assert.equal(f.stored.mode, "off");
  f.controller.stop();
});

test("auto holds while agents run and releases after the grace period", async () => {
  let running: number | null = 2;
  const f = fakes({ mode: "auto", until: "", keepDisplay: false, lidClosed: false }, () => running);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  assert.equal(f.controller.status().agents, 2);
  running = 0;
  f.advance(60_000);
  await f.controller.tick();
  assert.equal(f.keeper.active(), true, "still inside grace");
  f.advance(GRACE_MS);
  await f.controller.tick();
  assert.equal(f.keeper.active(), false);
  f.controller.stop();
});

test("auto with no answer yet stays released and says so", async () => {
  const f = fakes({ mode: "auto", until: "", keepDisplay: false, lidClosed: false }, () => null);
  await f.controller.start();
  assert.equal(f.keeper.active(), false);
  assert.equal(f.controller.status().busy, false);
  assert.equal(f.controller.status().agents, 0);
  f.controller.stop();
});

test("set off releases and writes", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "off" });
  assert.equal(status.active, false);
  assert.equal(f.keeper.active(), false);
  assert.deepEqual(f.writes.at(-1), { mode: "off", until: "", keepDisplay: false, lidClosed: false });
  f.controller.stop();
});

test("switching on to timer restarts the child with a deadline", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  assert.equal(f.held.at(-1), undefined);
  await f.controller.set({ mode: "timer", minutes: 60 });
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T19:00:00.000Z"));
  f.controller.stop();
});

test("the display switch reaches the child and is written down", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  assert.equal(f.heldDisplay.at(-1), false);
  const status = await f.controller.setOptions({ keepDisplay: true });
  assert.equal(status.keepDisplay, true);
  assert.equal(f.heldDisplay.at(-1), true);
  assert.deepEqual(f.writes.at(-1), { mode: "on", until: "", keepDisplay: true, lidClosed: false });
  f.controller.stop();
});

test("changing the display choice restarts the child, because caffeinate cannot be retold", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  const before = f.releaseCount();
  await f.controller.setOptions({ keepDisplay: true });
  assert.equal(f.releaseCount(), before + 1);
  assert.equal(f.keeper.active(), true);
  f.controller.stop();
});

test("setting the display to what it already is neither writes nor restarts", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: true, lidClosed: false }, () => 0);
  await f.controller.start();
  const writes = f.writes.length;
  const releases = f.releaseCount();
  await f.controller.setOptions({ keepDisplay: true });
  assert.equal(f.writes.length, writes);
  assert.equal(f.releaseCount(), releases);
  f.controller.stop();
});

test("a patch with both switches writes once, restarts once and syncs lid mode once", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0, lid);
  await f.controller.start();
  const writes = f.writes.length;
  const releases = f.releaseCount();
  await f.controller.setOptions({ keepDisplay: true, lidClosed: true });
  assert.equal(f.writes.length, writes + 1);
  assert.equal(f.releaseCount(), releases + 1);
  assert.deepEqual(lid.calls, ["forever"]);
  assert.equal(f.heldDisplay.at(-1), true);
  f.controller.stop();
});

test("the display switch leaves lid mode alone, and a mode change carries it", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  await f.controller.setOptions({ keepDisplay: true });
  assert.deepEqual(lid.calls, []);
  await f.controller.set({ mode: "timer", minutes: 60 });
  assert.equal(f.stored.keepDisplay, true);
  assert.equal(f.heldDisplay.at(-1), true);
  f.controller.stop();
});

test("the lid switch is written down and carried through a mode change", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  const status = await f.controller.setOptions({ lidClosed: true });
  assert.equal(status.lidClosed, true);
  assert.deepEqual(f.writes.at(-1), { mode: "on", until: "", keepDisplay: false, lidClosed: true });
  await f.controller.set({ mode: "timer", minutes: 60 });
  assert.equal(f.stored.lidClosed, true);
  f.controller.stop();
});

test("the lid switch does not restart the child: it has nothing to do with caffeinate", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  const releases = f.releaseCount();
  await f.controller.setOptions({ lidClosed: true });
  assert.equal(f.releaseCount(), releases);
  assert.equal(f.keeper.active(), true);
  f.controller.stop();
});

test("setting the lid switch to what it already is writes nothing", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  const writes = f.writes.length;
  await f.controller.setOptions({ lidClosed: true });
  assert.equal(f.writes.length, writes);
  assert.deepEqual(lid.calls, []);
  f.controller.stop();
});

test("with the lid switch on, a timer turns lid mode on until the timer's own deadline", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  await f.controller.set({ mode: "timer", minutes: 120 });
  assert.equal(f.stored.until, "2026-09-09T20:00:00.000Z");
  assert.deepEqual(lid.calls, ["until 2026-09-09T20:00:00.000Z"]);
  f.controller.stop();
});

test("with the lid switch on, On turns lid mode on with no end", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "timer", until: "2026-09-09T19:00:00.000Z", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  await f.controller.set({ mode: "on" });
  assert.deepEqual(lid.calls, ["forever"]);
  f.controller.stop();
});

test("Off and Auto turn lid mode off; the switch stays on", async () => {
  for (const mode of ["off", "auto"] as const) {
    const lid = fakeLid();
    const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
    await f.controller.start();
    await f.controller.set({ mode: "on" });
    await f.controller.set({ mode });
    assert.deepEqual(lid.calls, ["forever", `off: mode ${mode}`], mode);
    assert.equal(f.stored.lidClosed, true, mode);
    f.controller.stop();
  }
});

test("turning the switch on mid-timer covers the rest of the timer; off ends lid mode", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: false }, () => 0, lid);
  await f.controller.start();
  await f.controller.set({ mode: "timer", minutes: 60 });
  assert.deepEqual(lid.calls, [], "switch off: the lid sleeps the Mac as usual");
  f.advance(20 * 60_000);
  await f.controller.setOptions({ lidClosed: true });
  assert.deepEqual(lid.calls, ["until 2026-09-09T19:00:00.000Z"]);
  assert.equal(lid.status().minutes, 40);
  await f.controller.setOptions({ lidClosed: false });
  assert.deepEqual(lid.calls.at(-1), "off: lid switch off");
  f.controller.stop();
});

test("an Off pressed while On is still switching lid mode on still ends with lid mode off", async () => {
  const lid = fakeLid(30);
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  const on = f.controller.set({ mode: "on" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.controller.set({ mode: "off" });
  await on;
  assert.equal(f.stored.mode, "off");
  assert.equal(lid.status().on, false);
  assert.deepEqual(lid.calls, ["forever", "off: mode off"]);
  f.controller.stop();
});

test("a timer already spent but not yet ticked to Off does not switch lid mode on", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "timer", until: "2026-09-09T18:30:00.000Z", keepDisplay: false, lidClosed: false }, () => 0, lid);
  await f.controller.start();
  f.advance(31 * 60_000);
  await f.controller.setOptions({ lidClosed: true });
  assert.deepEqual(lid.calls, []);
  f.controller.stop();
});

test("after the permission arrives, a running On gets its lid mode", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  assert.deepEqual(lid.calls, [], "start alone changes nothing");
  await f.controller.syncLid();
  assert.deepEqual(lid.calls, ["forever"]);
  f.controller.stop();
});

test("turned off by something else, lid mode comes back only when asked: as the timer says", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  await f.controller.set({ mode: "timer", minutes: 60 });
  lid.endByItself();
  await f.controller.tick();
  assert.deepEqual(lid.calls, ["until 2026-09-09T19:00:00.000Z"]);
  f.advance(15 * 60_000);
  await f.controller.syncLid();
  assert.deepEqual(lid.calls, ["until 2026-09-09T19:00:00.000Z", "until 2026-09-09T19:00:00.000Z"]);
  assert.equal(lid.status().minutes, 45, "the rest of the timer, not a new length");
  f.controller.stop();
});

test("asking for lid mode back under Auto or with the switch off does nothing", async () => {
  for (const [mode, lidClosed] of [["auto", true], ["on", false]] as const) {
    const lid = fakeLid();
    const f = fakes({ mode, until: "", keepDisplay: false, lidClosed }, () => 0, lid);
    await f.controller.start();
    await f.controller.syncLid();
    assert.deepEqual(lid.calls, [], `${mode}, switch ${lidClosed}`);
    f.controller.stop();
  }
});

test("lid mode that ended by itself is not turned back on by a tick", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  await f.controller.start();
  await f.controller.set({ mode: "on" });
  lid.endByItself();
  await f.controller.tick();
  await f.controller.tick();
  assert.deepEqual(lid.calls, ["forever"]);
  f.controller.stop();
});

test("lid mode Caffeine did not start is left alone by a mode change", async () => {
  const lid = fakeLid();
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: true }, () => 0, lid);
  // Sleep switched off by hand: on, with no deadline and no end of Caffeine's.
  (lid.status() as { on: boolean }).on = true;
  await f.controller.start();
  await f.controller.set({ mode: "off" });
  assert.deepEqual(lid.calls, []);
  f.controller.stop();
});

test("the battery is read once a tick and reaches the status", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  let reads = 0;
  const controller = createController({
    read: async () => ({ mode: "off", until: "", keepDisplay: false, lidClosed: false }),
    write: async () => undefined,
    keeper: f.keeper,
    runningCount: async () => 0,
    readBattery: async () => {
      reads += 1;
      return { percent: 42, charging: true, charged: false, external: true, minutes: 90, adapterWatts: 96, inputWatts: 61, batteryWatts: 38 };
    },
    tickMs: 60 * 60_000,
  });
  await controller.start();
  assert.equal(reads, 1);
  assert.equal(controller.status().battery?.percent, 42);
  await controller.tick();
  assert.equal(reads, 2);
  controller.stop();
});

test("a controller with no battery probe simply has none", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  assert.equal(f.controller.status().battery, null);
  f.controller.stop();
});

test("a half-hour timer lands thirty minutes out", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "timer", minutes: 30 });
  assert.equal(status.until, "2026-09-09T18:30:00.000Z");
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T18:30:00.000Z"));
  f.controller.stop();
});

test("an empty patch writes nothing and leaves the child alone", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: true }, () => 0);
  await f.controller.start();
  const writes = f.writes.length;
  const releases = f.releaseCount();

  const status = await f.controller.setOptions({});
  assert.equal(status.lidClosed, true);
  assert.equal(f.writes.length, writes);
  assert.equal(f.releaseCount(), releases);
  assert.equal(f.keeper.active(), true);
  f.controller.stop();
});

test("a spent timer keeps the lid switch", async () => {
  const f = fakes({ mode: "timer", until: "2026-09-09T18:30:00.000Z", keepDisplay: false, lidClosed: true }, () => 0);
  await f.controller.start();
  f.advance(31 * 60_000);
  const status = await f.controller.tick();
  assert.equal(status.mode, "off");
  assert.equal(status.lidClosed, true);
  f.controller.stop();
});

test("the wake link is read afresh on every status", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  assert.equal(f.controller.status().wakeUrl, "");

  // The address moves with the network — a new lease, a VPN, a different house — so the
  // snapshot asks for it rather than remembering what it was told at startup.
  f.setWakeUrl("http://192.168.1.10:9999");
  assert.equal(f.controller.status().wakeUrl, "http://192.168.1.10:9999");
  f.controller.stop();
});

test("sleep lets the hold go before asking the Mac to suspend", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  const releases = f.releaseCount();
  const writes = f.writes.length;

  const status = f.controller.sleep();
  // Order is the whole fix: caffeinate -s outranks pmset sleepnow, and a sleep asked
  // for under a live hold buys a DarkWake and nothing more.
  assert.equal(f.releaseCount(), releases + 1);
  assert.equal(f.sleepCount(), 1);
  assert.equal(status.active, false);
  // The mode itself is untouched and nothing is written: sleeping is an act, not a mode.
  assert.equal(status.mode, "on");
  assert.equal(f.writes.length, writes);
  f.controller.stop();
});

test("the hold comes back on the next tick after a sleep", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, () => 0);
  await f.controller.start();
  f.controller.sleep();
  assert.equal(f.keeper.active(), false);

  // Whether the Mac went under or the suspend was refused, the policy is still "on" —
  // so the tick takes the hold again. A Mac woken by the link would otherwise get one
  // idle minute before macOS put it straight back.
  const status = await f.controller.tick();
  assert.equal(status.active, true);
  assert.equal(status.mode, "on");
  f.controller.stop();
});
