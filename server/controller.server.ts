import type { Battery, LidStatus, SetInput, SetOptionsInput, Status, WarmupStatus } from "../shared/caffeine.shared.ts";
import type { Keeper } from "./keeper.server.ts";
import { TICK_MS, type Stored, decide, defaultStored, nextBusyUntil, untilForMinutes } from "./policy.ts";

export interface ControllerDeps {
  read(): Promise<Stored>;
  write(stored: Stored): Promise<void>;
  keeper: Keeper;
  runningCount(): Promise<number | null>;
  /** The battery, read once per tick; null on a machine that has none. */
  readBattery?(): Promise<Battery | null>;
  /** The link that wakes this Mac, re-read on every snapshot because the address moves. */
  wakeUrl?(): string;
  /** Orders the Mac under; absent in tests that have no business suspending anything. */
  sleepNow?(): void;
  /** Lid mode, checked on the same tick and turned on and off with the timer and On when
   *  the lid switch is on; absent in tests that do not touch it. */
  lid?: {
    tick(battery: Battery | null): Promise<void>;
    status(): LidStatus;
    enable?(length: number | "forever", untilMs?: number): Promise<void>;
    disable?(why: string): Promise<void>;
  };
  /** Session warm-up, checked on the same tick; absent in tests that do not touch it. */
  warmup?: { tick(): Promise<void>; status(): WarmupStatus };
  now?: () => number;
  tickMs?: number;
  log?: (line: string) => void;
}

export interface Controller {
  start(): Promise<void>;
  stop(): void;
  status(): Status;
  set(input: SetInput): Promise<Status>;
  setOptions(patch: SetOptionsInput): Promise<Status>;
  /** Brings lid mode in line with the mode and the switch, as a change would: after the
   *  one-time permission arrives, for a timer or On already running. */
  syncLid(): Promise<Status>;
  /** Snapshots first, then asks for sleep: the answer has to outrun the suspend. */
  sleep(): Status;
  tick(): Promise<Status>;
}

/**
 * One tick: ask about agents, move the busy window, decide, reconcile the child. The
 * same routine runs on a timer and right after every `set`, so a switch is felt at once
 * and a timer expires within TICK_MS of its deadline.
 */
export function createController(deps: ControllerDeps): Controller {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TICK_MS;
  const log = deps.log ?? (() => undefined);

  let stored: Stored = defaultStored();
  let busyUntil = 0;
  let agents = 0;
  let battery: Battery | null = null;
  let lastReason = "";
  let tickAt = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function snapshot(): Status {
    return {
      mode: stored.mode,
      until: stored.until,
      active: deps.keeper.active(),
      busy: now() < busyUntil,
      agents,
      error: deps.keeper.error(),
      tickAt,
      keepDisplay: stored.keepDisplay,
      lidClosed: stored.lidClosed,
      wakeUrl: deps.wakeUrl?.() ?? "",
      battery,
      lid: deps.lid?.status() ?? { on: false, until: "", minutes: 0, forever: false, ended: "", stopped: "", setup: "unknown", error: "" },
      warmup: deps.warmup?.status() ?? { enabled: false, time: "06:00", nextAt: "", lastAt: "", results: [], running: false },
    };
  }

  /**
   * Lid mode follows the mode when the lid switch is on: the timer's deadline under a timer,
   * no end under On. Off and Auto turn it off, and so does the switch. Only on a change a
   * person made, never on a tick: lid mode that ended on a low battery or heat stays off
   * until somebody picks again. Lid mode Caffeine did not start (sleep switched off by hand)
   * is not turned off by a mode change; a timer or On with the switch on takes it over.
   */
  async function syncLid(): Promise<void> {
    const lid = deps.lid;
    if (!lid?.enable || !lid.disable) return;
    const current = lid.status();
    const ours = current.forever || current.until !== "";
    const want = stored.lidClosed && (stored.mode === "timer" || stored.mode === "on");
    try {
      if (!want) {
        if (ours) await lid.disable(stored.lidClosed ? `mode ${stored.mode}` : "lid switch off");
      } else if (stored.mode === "on") {
        if (!current.forever) await lid.enable("forever");
      } else if (current.until !== stored.until) {
        const untilMs = Date.parse(stored.until);
        // A timer already spent, which the next tick turns into Off: nothing to cover.
        if (untilMs > now()) await lid.enable(Math.max(1, Math.round((untilMs - now()) / 60_000)), untilMs);
      }
    } catch (failure) {
      log(`caffeine: lid change failed: ${String(failure)}`);
    }
  }

  /**
   * Changes run one at a time. Lid mode takes seconds to switch (sudo, pmset), and an Off
   * pressed while an On is still switching it would otherwise read lid mode as not yet on,
   * leave it, and let the On finish: sleep switched off with no end under Off.
   */
  let changes: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(change: () => Promise<T>): Promise<T> {
    const next = changes.then(change);
    changes = next.catch(() => undefined);
    return next;
  }

  async function reconcile(): Promise<Status> {
    const nowMs = now();
    const running = await deps.runningCount();
    agents = running ?? 0;
    // The battery has no say in whether the Mac stays awake; it is read here only
    // because this is the one place that already runs on a timer.
    if (deps.readBattery) battery = await deps.readBattery();
    // Lid mode ends at its deadline or on a low battery whatever the mode says.
    if (deps.lid) await deps.lid.tick(battery).catch((failure) => log(`caffeine: lid check failed: ${String(failure)}`));
    // Not awaited: a warm-up runs `claude` once per login, which takes seconds, and the tick
    // that decides whether the Mac stays awake must not wait on it.
    if (deps.warmup) void deps.warmup.tick().catch((failure) => log(`caffeine: warm-up failed: ${String(failure)}`));
    busyUntil = nextBusyUntil(busyUntil, running, nowMs);

    const decision = decide(stored, nowMs, busyUntil);
    if (decision.stored !== stored) {
      stored = decision.stored;
      await deps.write(stored);
    }

    if (decision.active) {
      deps.keeper.hold(stored.mode === "timer" ? Date.parse(stored.until) : undefined, stored.keepDisplay);
    } else {
      deps.keeper.release();
    }

    if (decision.reason !== lastReason) {
      log(`caffeine: ${decision.reason} (active=${decision.active}, agents=${agents})`);
      lastReason = decision.reason;
    }
    tickAt = new Date(nowMs).toISOString();
    return snapshot();
  }

  return {
    async start() {
      stored = await deps.read();
      await reconcile();
      timer = setInterval(() => {
        if (!stopped) void reconcile().catch((error) => log(`caffeine: tick failed: ${String(error)}`));
      }, tickMs);
    },

    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      deps.keeper.release();
    },

    status: snapshot,

    set: (input) => oneAtATime(async () => {
      // The switches ride through a mode change untouched: the display is a property of
      // the machine the user is sitting at, and the lid switch says what the timer and On
      // mean, not which of them is running.
      const next: Stored =
        input.mode === "timer"
          ? { ...stored, mode: "timer", until: untilForMinutes(now(), input.minutes) }
          : { ...stored, mode: input.mode, until: "" };
      // A different deadline or a different mode needs a child with different
      // arguments, so the old one goes first and reconcile() starts the right one.
      if (next.mode !== stored.mode || next.until !== stored.until) deps.keeper.release();
      stored = next;
      await deps.write(stored);
      await syncLid();
      return reconcile();
    }),

    setOptions: (patch) => oneAtATime(async () => {
      const next: Stored = {
        ...stored,
        keepDisplay: patch.keepDisplay ?? stored.keepDisplay,
        lidClosed: patch.lidClosed ?? stored.lidClosed,
      };
      if (next.keepDisplay === stored.keepDisplay && next.lidClosed === stored.lidClosed) return reconcile();
      // caffeinate cannot be told to drop -d while it runs, so the child goes and
      // reconcile() starts one with the right arguments.
      if (next.keepDisplay !== stored.keepDisplay) deps.keeper.release();
      const lidChanged = next.lidClosed !== stored.lidClosed;
      stored = next;
      await deps.write(stored);
      if (lidChanged) await syncLid();
      return reconcile();
    }),

    syncLid: () =>
      oneAtATime(async () => {
        await syncLid();
        return reconcile();
      }),

    /**
     * The hold goes first, and it has to. `caffeinate -s` outranks `pmset sleepnow`:
     * under a hold the Mac drops to DarkWake and sits there, awake in every way that
     * costs power, until the hold ends of its own accord. Measured on this machine —
     * `sleepnow` at 23:34:28 gave "Entering DarkWake state", and the real "Entering
     * Sleep state" arrived at 23:40:40, six minutes later, when caffeinate let go.
     *
     * Killing the child is enough; the mode is left alone. Sleeping is an act rather
     * than a mode, so the Mac comes back under the same policy it went under with and
     * the next tick takes the hold again — which matters, because a Mac woken by the
     * link would otherwise have a minute of idle before macOS put it straight back.
     *
     * The second the sleeper waits before calling pmset is also the second the child
     * needs to die in.
     */
    sleep() {
      deps.keeper.release();
      log(`caffeine: sleep asked for (was ${stored.mode}, hold released)`);
      deps.sleepNow?.();
      return snapshot();
    },

    tick: reconcile,
  };
}
