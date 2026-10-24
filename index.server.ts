import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { dismissThermal, getStatus, preferences, runWarmup, setLid, setMode, setOptions, setWarmup, setupLid, sleepNow } from "./shared/caffeine.shared.ts";
import { createWarmup, systemWarmupDeps } from "./server/warmup.server.ts";
import { HEAT_FILES, createLid, systemLidDeps } from "./server/lid.server.ts";
import { emergencySleep, parseSystemSleepHolders } from "./server/emergency.server.ts";
import { HEAT_TICK_MS, createHeat, fileLatch, fileLock } from "./server/heat.server.ts";
import { runCommand, systemHeatSensors } from "./server/sensors.server.ts";
import { createActions } from "./server/actions.server.ts";
import { createAgentsProbe } from "./server/agents.server.ts";
import { createBatteryProbe } from "./server/battery.server.ts";
import { describeCaffeine, describeRpc } from "./server/capabilities.server.ts";
import { type Controller, createController } from "./server/controller.server.ts";
import { createKeeper } from "./server/keeper.server.ts";
import { renderWakePage } from "./server/page.server.ts";
import { createSleeper } from "./server/sleeper.server.ts";
import { readStored, writeStored } from "./server/state.server.ts";
import { createWaker } from "./server/waker.server.ts";

export default function contribute(server: PluginServerContext) {
  // This file only ever loads on the daemon, so the probe and the controller are built
  // unconditionally, right here — no isServer() guard, no lazy construction to dodge a
  // client bundle that no longer exists for this module.
  const probe = createAgentsProbe();
  const power = createBatteryProbe();
  // The page is rendered per request rather than held: whoever reads it has just woken
  // the Mac, and wants to know what it looks like now — not what it looked like when the
  // plugin loaded. `controller` is referenced before its declaration on purpose; by the
  // time a browser asks, it has long existed.
  const waker = createWaker({
    render: () => {
      const status = controller.status();
      return renderWakePage({
        host: hostname(),
        at: new Date(),
        mode: status.mode,
        active: status.active,
        battery: status.battery,
      });
    },
  });
  const sleeper = createSleeper({ log: (line) => console.log(line) });
  const log = (line: string) => console.log(line);
  const keeper = createKeeper({ pidFile: HEAT_FILES.keeperPid });
  // `heat` is referenced before its declaration on purpose: lid mode asks it only once a
  // person turns lid mode on, long after both exist.
  const lid = createLid({ ...systemLidDeps(log), gate: () => heat.gate(), latched: () => heat.latched() });
  const heatLock = fileLock(HEAT_FILES.lock);
  const heatLatch = fileLatch(HEAT_FILES.latch);
  const heat = createHeat({
    sensors: systemHeatSensors(log),
    armed: () => lid.status().on,
    files: HEAT_FILES,
    emergency: (trip, dryRun) =>
      emergencySleep(trip, {
        dryRun: () => dryRun,
        lock: () => heatLock.take(),
        unlock: () => heatLock.release(),
        writeLatch: (record) => heatLatch.write(record),
        allowSleep: () => lid.endForHeat(),
        releaseHold: () => keeper.release(),
        holders: async () =>
          parseSystemSleepHolders((await runCommand("/usr/bin/pmset", ["-g", "assertions"])).stdout, keeper.pid() === null ? [] : [keeper.pid() as number]),
        sleepNow: async () => void (await runCommand("/usr/bin/pmset", ["sleepnow"])),
        // The monotonic clock stops while the Mac sleeps and the wall clock does not.
        waitGap: (ms) =>
          new Promise((resolve) => {
            const wall = Date.now();
            const monotonic = performance.now();
            setTimeout(() => resolve(Date.now() - wall - (performance.now() - monotonic)), ms);
          }),
        now: () => Date.now(),
        log,
      }),
    endForHeat: () => lid.endForHeat(),
    resleep: async () => {
      keeper.release();
      await runCommand("/usr/bin/pmset", ["sleepnow"]);
    },
    log,
  });
  const warmup = createWarmup(systemWarmupDeps((line) => console.log(line)));
  const controller: Controller = createController({
    read: () => readStored(),
    write: (stored) => writeStored(stored),
    keeper,
    runningCount: () => probe.runningCount(),
    readBattery: () => power.read(),
    wakeUrl: () => waker.url(),
    sleepNow: () => sleeper.request(),
    lid,
    warmup,
    heat,
    log: (line) => console.log(line),
  });

  let started: Promise<void> | null = null;
  function startedServer(): Promise<Controller> {
    // The anchor comes up with the controller rather than on first use: it has to be
    // listening and announced *before* the Mac sleeps, and nobody opens a plugin surface
    // on the way to closing the lid.
    // Lid first: a deadline that passed while the daemon was down is put right before
    // anything else reads the system.
    started ??= lid
      .start()
      .catch((error) => console.error(`caffeine: lid start failed: ${String(error)}`))
      .then(() => warmup.start())
      .catch((error) => console.error(`caffeine: warm-up start failed: ${String(error)}`))
      .then(() => waker.start())
      .then(() => controller.start());
    return started.then(() => controller);
  }

  // Restore the stored mode as soon as the daemon loads the plugin, so a Mac left
  // "on" overnight stays on through a daemon restart without anybody opening the app.
  void startedServer().catch((error) => console.error(`caffeine: start failed: ${String(error)}`));

  // The preferences its Settings screen and the fan popup edit. SDK 0.8's types say
  // registerSettings returns nothing; the host has handed back { read, subscribe } since
  // Paseo 0.11 (plugin-process `registerSettings`), so it is used where it is there and the
  // heat guard keeps its defaults where it is not. Warm-up's switch is handled by the
  // Settings screen itself (client/settings.tsx).
  let stopPreferences: () => unknown = () => undefined;
  // Read by the warm-up switch, which refuses to come on while hidden (server/actions.server.ts).
  let warmupHidden = false;
  try {
    const handle = server.registerSettings(preferences) as unknown as Partial<HostSettings> | undefined;
    const apply = (state: HostSettingsState) => {
      if (state.status !== "ready" || !state.values) return;
      heat.setStored(state.values);
      warmupHidden = state.values.warmup === false;
      // Warm-up hidden is warm-up off, whether hidden by hand or by default: nothing unseen
      // messages the accounts. Only once warm-up has read its own state, so its hour survives.
      if (state.values.warmup === false) {
        void startedServer()
          .then(async () => {
            if (!warmup.status().enabled) return;
            await warmup.set({ enabled: false });
            console.log("caffeine: warm-up switched off: its tile is hidden");
          })
          .catch((error) => console.error(`caffeine: warm-up not switched off: ${String(error)}`));
      }
    };
    if (typeof handle?.subscribe === "function") stopPreferences = handle.subscribe(apply);
    if (typeof handle?.read === "function") void handle.read().then(apply).catch((error) => console.error(`caffeine: preferences unreadable: ${String(error)}`));
  } catch (error) {
    console.error(`caffeine: preferences unavailable, heat guard on its defaults: ${String(error)}`);
  }

  // The heat guard looks every 15 s, on its own timer: the controller's 30 s tick waits on
  // agents and the battery, and a guard should not wait on those.
  void heat.tick().catch((error) => console.error(`caffeine: heat check failed: ${String(error)}`));
  const heatWatch = setInterval(() => void heat.tick().catch((error) => console.error(`caffeine: heat check failed: ${String(error)}`)), HEAT_TICK_MS);

  // Every change answers with a verdict on itself as well as the status (server/actions.server.ts).
  const actions = createActions({ controller: startedServer, lid, heat, warmup, warmupHidden: () => warmupHidden, log });

  server.handle(dismissThermal, (_input, { paseo }) => {
    probe.remember(paseo);
    return actions.dismissHeat();
  });

  server.handle(getStatus, async (_input, { paseo }) => {
    probe.remember(paseo);
    const instance = await startedServer();
    return instance.status();
  });

  server.handle(setMode, (input, { paseo }) => {
    probe.remember(paseo);
    return actions.set(input);
  });

  server.handle(setOptions, (input, { paseo }) => {
    probe.remember(paseo);
    return actions.setOptions(input);
  });

  server.handle(sleepNow, (_input, { paseo }) => {
    probe.remember(paseo);
    return actions.sleep();
  });

  server.handle(setLid, (input, { paseo }) => {
    probe.remember(paseo);
    return actions.lid(input);
  });

  server.handle(setupLid, async (_input, { paseo }) => {
    probe.remember(paseo);
    const instance = await startedServer();
    await lid.setup();
    // The permission is asked for by a press on the lid switch, so once it is given the switch
    // comes on. Here rather than in the client, which may have stopped waiting for the dialog.
    if (lid.status().setup === "ready" && !instance.status().lidClosed) return instance.setOptions({ lidClosed: true });
    // A timer or On already running with the switch on gets its lid mode now, not at the
    // next pick.
    return instance.syncLid();
  });

  server.handle(setWarmup, (input, { paseo }) => {
    probe.remember(paseo);
    return actions.setWarmup(input);
  });

  server.handle(runWarmup, (input, { paseo }) => {
    probe.remember(paseo);
    return actions.runWarmup(input);
  });

  // For God Mode: the operations above, described for an assistant that cannot see them.
  server.handle(describeRpc, () => describeCaffeine());

  // Under lid mode the lid is looked at once a minute: putting the display to sleep a little
  // late is fine, and every look while the lid stays shut puts it to sleep again (checkClosed).
  const lidWatch = setInterval(() => void lid.checkClosed().catch(() => undefined), LID_CHECK_MS);
  lidWatch.unref?.();

  return () => {
    clearInterval(lidWatch);
    clearInterval(heatWatch);
    void stopPreferences();
    controller.stop();
    waker.stop();
  };
}

const LID_CHECK_MS = 60_000;

/** The slice of the host's settings handle the server uses (see registerSettings above). */
interface HostSettingsState {
  status: string;
  values?: Record<string, unknown>;
}
interface HostSettings {
  read(): Promise<HostSettingsState>;
  subscribe(listener: (state: HostSettingsState) => void): () => unknown;
}
