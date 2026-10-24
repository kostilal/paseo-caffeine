import { test } from "node:test";
import assert from "node:assert/strict";
import { type SetInput, type SetOptionsInput, type Status, type WarmupStatus, status as statusSchema } from "../shared/caffeine.shared.ts";
import type { Controller } from "./controller.server.ts";
import { NEEDS_SETUP, WARMUP_HIDDEN, createActions, holdProblem, lidOffProblem, lidOnProblem, warmupProblem } from "./actions.server.ts";

/** A status as the controller hands it out: the schema's defaults under `patch`. */
function make(patch: Record<string, unknown> = {}): Status {
  return statusSchema.parse({ mode: "off", active: false, busy: false, agents: 0, ...patch });
}

/** What each part leaves behind; left out, the change simply takes. */
interface Rules {
  set?(status: Status, input: SetInput): Status;
  setOptions?(status: Status, patch: SetOptionsInput): Status;
  syncLid?(status: Status): Status;
  /** What turning lid mode off leaves: off, unless a test says pmset refused. */
  disable?(status: Status): Status;
}

/**
 * The actions over stand-ins that keep one status, the way the controller and lid mode share
 * one in the plugin, and write down every call: whether a refused change touched anything is
 * read from `calls`.
 */
function world(start: Status, rules: Rules = {}, options: { hidden?: boolean; warmup?: Partial<WarmupStatus> } = {}) {
  let current = start;
  let warm: WarmupStatus = { ...start.warmup, ...options.warmup };
  let finish: () => void = () => undefined;
  const calls: string[] = [];
  const read = (): Status => ({ ...current, warmup: warm });
  const controller: Controller = {
    start: async () => undefined,
    stop: () => undefined,
    status: read,
    tick: async () => read(),
    set: async (input) => {
      calls.push(`set ${input.mode}`);
      current = rules.set ? rules.set(current, input) : { ...current, mode: input.mode };
      return read();
    },
    setOptions: async (patch) => {
      calls.push(`options ${JSON.stringify(patch)}`);
      current = rules.setOptions ? rules.setOptions(current, patch) : { ...current, ...patch };
      return read();
    },
    syncLid: async () => {
      calls.push("sync lid");
      current = rules.syncLid ? rules.syncLid(current) : current;
      return read();
    },
    sleep: () => {
      calls.push("sleep");
      return read();
    },
  };
  const actions = createActions({
    controller: async () => controller,
    lid: {
      status: () => current.lid,
      disable: async (why) => {
        calls.push(`lid off: ${why}`);
        current = rules.disable ? rules.disable(current) : { ...current, lid: { ...current.lid, on: false, forever: false, until: "" } };
      },
    },
    heat: {
      dismiss: async () => {
        calls.push("dismiss");
        current = { ...current, thermal: { ...current.thermal, event: null } };
      },
    },
    warmup: {
      status: () => warm,
      set: async (patch) => {
        calls.push(`warm-up ${JSON.stringify(patch)}`);
        warm = { ...warm, ...patch };
      },
      runNow: () => {
        calls.push("warm up");
        warm = { ...warm, running: true };
        return new Promise<void>((resolve) => {
          finish = () => {
            warm = { ...warm, running: false };
            resolve();
          };
        });
      },
    },
    warmupHidden: () => options.hidden ?? false,
  });
  const finishWarmup = (results: WarmupStatus["results"]) => {
    warm = { ...warm, results };
    finish();
  };
  return { actions, calls, finishWarmup };
}

const ON_WITH_LID = { mode: "on", lidClosed: true } as const;
const lidModeOn = { on: true, forever: true, setup: "ready" } as const;
const needsSetup = { on: false, setup: "needs-setup", error: "needs-setup" } as const;

test("a mode that took answers with no verdict", async () => {
  const { actions } = world(make({ lidClosed: true, lid: { setup: "ready" } }), { set: (s, input) => ({ ...s, mode: input.mode, active: true, lid: { ...s.lid, ...lidModeOn } }) });
  const answered = await actions.set({ mode: "on" });
  assert.equal(answered.refused, "");
  assert.equal(answered.problem, "");
  assert.equal(answered.lid.on, true);
});

test("On with the lid switch on says so when lid mode did not come with it", async () => {
  const { actions } = world(make({ lidClosed: true }), { set: (s, input) => ({ ...s, mode: input.mode, active: true, lid: { ...s.lid, ...needsSetup } }) });
  const answered = await actions.set({ mode: "on" });
  assert.equal(answered.refused, "", "the Mac is held: the change was made");
  assert.match(answered.problem, /lid mode is off, so a closed lid sleeps the Mac/);
  assert.match(answered.problem, /permission given at the Mac/);
});

test("Off and While agents work say so when sleep does not come back", async () => {
  for (const mode of ["off", "auto"] as const) {
    const stuck = { ...lidModeOn, error: "pmset -a disablesleep 0 failed (exit 1)" };
    const { actions } = world(make({ ...ON_WITH_LID, lid: lidModeOn }), { set: (s, input) => ({ ...s, mode: input.mode, lid: { ...s.lid, ...stuck } }) });
    const answered = await actions.set({ mode });
    assert.match(answered.problem, /lid mode is still on, so the Mac does not sleep.*exit 1/, mode);
  }
});

test("sleep switched off by hand is reported, not taken for Caffeine's", async () => {
  const { actions } = world(make({ mode: "on", lid: { on: true, setup: "ready" } }));
  const answered = await actions.set({ mode: "off" });
  assert.match(answered.problem, /switched off outside Caffeine/);
});

test("a hold that could not start, or that the heat guard keeps off, is reported", async () => {
  const failed = world(make(), { set: (s, input) => ({ ...s, mode: input.mode, active: false, error: "/usr/bin/caffeinate: spawn ENOENT" }) });
  assert.match((await failed.actions.set({ mode: "on" })).problem, /not holding the Mac awake: \/usr\/bin\/caffeinate/);
  const hot = world(make({ thermal: { state: "latched", lidClosed: true } }), { set: (s, input) => ({ ...s, mode: input.mode, active: false }) });
  assert.match((await hot.actions.set({ mode: "on" })).problem, /heat trip/);
  // Under a dry run the latch keeps nothing off, so nothing is said about it.
  const dry = world(make({ thermal: { state: "latched", lidClosed: true, dryRun: true } }), { set: (s, input) => ({ ...s, mode: input.mode, active: false }) });
  assert.equal((await dry.actions.set({ mode: "on" })).problem, "");
});

test("the lid switch is not flipped without the permission, and says where it is given", async () => {
  const { actions, calls } = world(make({ mode: "on", lid: { setup: "needs-setup" } }));
  const answered = await actions.setOptions({ lidClosed: true });
  assert.equal(answered.refused, NEEDS_SETUP);
  assert.equal(answered.lidClosed, false);
  assert.deepEqual(calls, [], "nothing was changed");
});

test("the lid switch flips when the permission is not known to be missing, and says when lid mode did not follow", async () => {
  const { actions, calls } = world(make({ mode: "on" }), {
    setOptions: (s, patch) => ({ ...s, ...patch, lid: { ...s.lid, on: false, error: "cooling" }, thermal: { ...s.thermal, coolAt: "2026-10-24T12:00:00.000Z" } }),
  });
  const answered = await actions.setOptions({ lidClosed: true });
  assert.deepEqual(calls, ['options {"lidClosed":true}']);
  assert.equal(answered.refused, "");
  assert.match(answered.problem, /heat guard keeps it off until the Mac has cooled down \(about 2026-10-24T12:00:00.000Z\)/);
});

test("turning the lid switch off says so when lid mode stays on", async () => {
  const off = world(make({ ...ON_WITH_LID, lid: lidModeOn }), { setOptions: (s, patch) => ({ ...s, ...patch, lid: { ...s.lid, on: false, forever: false } }) });
  assert.equal((await off.actions.setOptions({ lidClosed: false })).problem, "");
  const stuck = world(make({ ...ON_WITH_LID, lid: lidModeOn }), { setOptions: (s, patch) => ({ ...s, ...patch, lid: { ...s.lid, error: "pmset failed" } }) });
  assert.match((await stuck.actions.setOptions({ lidClosed: false })).problem, /still on.*pmset failed/);
});

test("the display switch is judged by the hold alone", async () => {
  const { actions } = world(make({ ...ON_WITH_LID, active: true, lid: needsSetup }));
  const answered = await actions.setOptions({ keepDisplay: true });
  assert.equal(answered.problem, "", "lid mode was not asked for, so it is not news here");
  assert.equal(answered.keepDisplay, true);
});

test("Sleep now ends lid mode first and only then asks for sleep", async () => {
  const { actions, calls } = world(make({ ...ON_WITH_LID, lid: lidModeOn }));
  const answered = await actions.sleep();
  assert.deepEqual(calls, ["lid off: sleep now", "sleep"]);
  assert.equal(answered.refused, "");
});

test("Sleep now asks for nothing when sleep cannot be switched back on, and says why", async () => {
  const { actions, calls } = world(make({ ...ON_WITH_LID, lid: lidModeOn }), { disable: (s) => ({ ...s, lid: { ...s.lid, error: "pmset -a disablesleep 0 failed (exit 1)" } }) });
  const answered = await actions.sleep();
  assert.deepEqual(calls, ["lid off: sleep now"], "pmset sleepnow would do nothing with sleep switched off");
  assert.match(answered.refused, /switched off system-wide.*exit 1/);
});

test("Sleep now without lid mode goes straight to sleep", async () => {
  const { actions, calls } = world(make({ mode: "on" }));
  assert.equal((await actions.sleep()).refused, "");
  assert.deepEqual(calls, ["sleep"]);
});

test("turn back on refuses when nothing asks for lid mode, and touches nothing", async () => {
  for (const start of [make({ mode: "auto", lidClosed: true }), make({ mode: "on", lidClosed: false })]) {
    const { actions, calls } = world(start);
    const answered = await actions.lid({ lid: "on" });
    assert.match(answered.refused, /nothing to turn back on/);
    assert.deepEqual(calls, []);
  }
});

test("turn back on is done only when lid mode is on afterwards", async () => {
  const back = world(make({ ...ON_WITH_LID, lid: { setup: "ready", stopped: "sleep" } }), { syncLid: (s) => ({ ...s, lid: { ...s.lid, ...lidModeOn, stopped: "" } }) });
  assert.equal((await back.actions.lid({ lid: "on" })).refused, "");
  const hot = world(make(ON_WITH_LID), { syncLid: (s) => ({ ...s, lid: { ...s.lid, on: false, error: "cooling", ended: "heat" } }) });
  assert.match((await hot.actions.lid({ lid: "on" })).refused, /did not come on: the heat guard keeps it off/);
});

test("switching sleep back on is done only when pmset says so", async () => {
  const off = world(make({ ...ON_WITH_LID, lid: lidModeOn }));
  assert.equal((await off.actions.lid({ lid: "off" })).refused, "");
  assert.deepEqual(off.calls, ["lid off: turned off"]);
  const stuck = world(make({ ...ON_WITH_LID, lid: lidModeOn }), { disable: (s) => ({ ...s, lid: { ...s.lid, error: "could not read whether sleep is back" } }) });
  assert.match((await stuck.actions.lid({ lid: "off" })).refused, /still switched off: could not read/);
});

test("dismissing the heat alert says when there was none", async () => {
  const event = { at: "2026-10-24T10:00:00.000Z", reason: "pressure" };
  const shown = world(make({ thermal: { event } }));
  const answered = await shown.actions.dismissHeat();
  assert.equal(answered.refused, "");
  assert.equal(answered.thermal.event, null);
  const none = world(make());
  assert.equal((await none.actions.dismissHeat()).refused, "there is no heat alert to dismiss");
});

test("warm-up does not come on while Settings hides it, and goes off either way", async () => {
  const hidden = world(make(), {}, { hidden: true });
  assert.equal((await hidden.actions.setWarmup({ enabled: true, time: "07:00" })).refused, WARMUP_HIDDEN);
  assert.deepEqual(hidden.calls, []);
  assert.equal((await hidden.actions.setWarmup({ enabled: false })).refused, "");
  const shown = world(make());
  const answered = await shown.actions.setWarmup({ enabled: true, time: "07:00" });
  assert.equal(answered.refused, "");
  assert.equal(answered.warmup.enabled, true);
  assert.equal(answered.warmup.time, "07:00");
});

test("warming up now without waiting answers at once, with the warm-up running", async () => {
  const { actions, calls, finishWarmup } = world(make());
  const answered = await actions.runWarmup({ wait: false });
  assert.equal(answered.warmup.running, true);
  assert.equal(answered.refused, "");
  assert.deepEqual(calls, ["warm up"]);
  finishWarmup([{ login: "a@example.com (.claude)", ok: true, error: "" }]);
});

test("a second warm-up is refused while one runs, and starts nothing", async () => {
  const { actions, calls } = world(make(), {}, { warmup: { running: true } });
  assert.match((await actions.runWarmup({ wait: false })).refused, /already running/);
  assert.deepEqual(calls, []);
});

test("a warm-up that was waited for names the logins it did not reach", async () => {
  const { actions, finishWarmup } = world(make());
  const pending = actions.runWarmup({ wait: true });
  // Let it reach the warm-up itself before that ends.
  await new Promise((resolve) => setImmediate(resolve));
  finishWarmup([
    { login: "a@example.com (.claude)", ok: true, error: "" },
    { login: "b@example.com (.claude-b)", ok: false, error: "exit 1" },
  ]);
  const answered = await pending;
  assert.equal(answered.problem, "not warmed up: b@example.com (.claude-b) (exit 1)");
  assert.equal(answered.warmup.running, false);
});

test("the verdicts read the status, not the request", () => {
  assert.equal(lidOnProblem(make({ ...ON_WITH_LID, lid: lidModeOn })), "");
  assert.equal(lidOnProblem(make({ mode: "auto", lidClosed: true })), "", "auto never asks for lid mode");
  assert.match(lidOnProblem(make({ mode: "timer", until: "2026-10-24T12:00:00.000Z", lidClosed: true, lid: { stopped: "off" } })), /turned off from the header/);
  assert.equal(lidOffProblem(make({ mode: "off" })), "");
  assert.equal(holdProblem(make({ mode: "auto", busy: false, active: false })), "", "auto with nothing running holds nothing");
  assert.match(holdProblem(make({ mode: "auto", busy: true, active: false, error: "caffeinate exited with 1" })), /exited with 1/);
  assert.equal(warmupProblem({ enabled: true, time: "06:00", nextAt: "", lastAt: "", results: [], running: false }), "no Claude login on this Mac to warm up");
});
