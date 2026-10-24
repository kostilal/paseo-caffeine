import type { Answer, LidStatus, LidStopped, SetInput, SetOptionsInput, Status, WarmupStatus } from "../shared/caffeine.shared.ts";
import type { Controller } from "./controller.server.ts";

/**
 * The changes a client asks for (the page, the Command Center, or an assistant through God
 * Mode), each answered with the status after it and a verdict on this one call: `refused` when
 * nothing was changed, `problem` when the change was made but part of it did not take. Both are
 * read from the status after the change, which reads the system (lid mode from `pmset -g`, the
 * hold from the caffeinate child), so an answer never claims a change that did not happen. God
 * Mode reports a refusal as not done (server/capabilities.server.ts); the page ignores both.
 */

export interface ActionDeps {
  /** The controller, started: index.server.ts starts it on first use. */
  controller(): Promise<Controller>;
  lid: { status(): LidStatus; disable(why: string, by?: LidStopped): Promise<void> };
  heat: { dismiss(): Promise<void> };
  warmup: { status(): WarmupStatus; set(patch: { enabled?: boolean; time?: string }): Promise<void>; runNow(): Promise<void> };
  /** Whether Settings hides Session warm-up, which keeps it off; false until the settings are read. */
  warmupHidden(): boolean;
  log?: (line: string) => void;
}

export interface Actions {
  set(input: SetInput): Promise<Answer>;
  setOptions(patch: SetOptionsInput): Promise<Answer>;
  sleep(): Promise<Answer>;
  lid(input: { lid: "on" | "off" }): Promise<Answer>;
  dismissHeat(): Promise<Answer>;
  setWarmup(patch: { enabled?: boolean; time?: string }): Promise<Answer>;
  runWarmup(input: { wait: boolean }): Promise<Answer>;
}

export const NEEDS_SETUP =
  "lid mode needs a one-time permission given at the Mac: a person there presses the lid switch on Caffeine's page and enters the password";

export const WARMUP_HIDDEN =
  "Session warm-up is hidden in Caffeine's Settings (Settings → Plugins → Caffeine → Settings), which keeps it off; show it there first";

export function answer(status: Status, verdict: { refused?: string; problem?: string } = {}): Answer {
  return { ...status, refused: verdict.refused ?? "", problem: verdict.problem ?? "" };
}

const join = (...parts: string[]) => parts.filter((part) => part !== "").join("; ");

/** What the timer and On mean while the lid switch is on (the controller's `wantsLid`). */
export function lidWanted(status: Status): boolean {
  return status.lidClosed && (status.mode === "on" || status.mode === "timer");
}

/** Why lid mode is off, from what the lid status says. */
export function lidOffReason(status: Status): string {
  const { lid, thermal } = status;
  if (lid.error === "needs-setup" || lid.setup === "needs-setup") return NEEDS_SETUP;
  if (lid.error === "cooling") return `the heat guard keeps it off until the Mac has cooled down${thermal.coolAt ? ` (about ${thermal.coolAt})` : ""}`;
  if (lid.error !== "") return lid.error;
  if (lid.ended === "battery") return "the battery ran low";
  if (lid.ended === "heat") return "the heat guard turned it off";
  if (lid.stopped === "sleep") return "Sleep now turned it off";
  if (lid.stopped === "off") return "it was turned off from the header";
  if (lid.stopped === "manual") return "sleep was switched back on by hand";
  return "pmset does not report sleep switched off";
}

/** After a change meant to bring lid mode on with the timer or On: whether it came. */
export function lidOnProblem(status: Status): string {
  return lidWanted(status) && !status.lid.on ? `lid mode is off, so a closed lid sleeps the Mac: ${lidOffReason(status)}` : "";
}

/** After a change meant to let the Mac sleep again: whether sleep really is back. */
export function lidOffProblem(status: Status): string {
  if (!status.lid.on) return "";
  const ours = status.lid.forever || status.lid.until !== "";
  return ours
    ? `lid mode is still on, so the Mac does not sleep, lid closed or not: ${status.lid.error || "sleep is still switched off"}`
    : "sleep was switched off outside Caffeine (pmset disablesleep) and stays off, so the Mac does not sleep, lid closed or not";
}

/** After a change of the mode or the display: whether Caffeine holds the Mac when it should. */
export function holdProblem(status: Status): string {
  const should = status.mode === "on" || status.mode === "timer" || (status.mode === "auto" && status.busy);
  if (!should || status.active) return "";
  const { thermal } = status;
  // A real latch with the lid not known to be open: the hold is off on purpose (heat.server.ts
  // holdSuspended).
  if (thermal.state === "latched" && !thermal.dryRun && thermal.lidClosed !== false) {
    return "Caffeine is not holding the Mac awake: after a heat trip the guard keeps a Mac with its lid closed asleep until it has cooled down";
  }
  return status.error === "" ? "" : `Caffeine is not holding the Mac awake: ${status.error}`;
}

/** Why "turn back on" has nothing to bring back. */
export function lidNotWanted(status: Status): string {
  const why = status.lidClosed ? `the mode is ${status.mode}` : "the lid switch is off";
  return `nothing to turn back on: lid mode runs only under a timer or On with the lid switch on, and ${why}`;
}

/** After a warm-up that was waited for: the logins it did not reach. */
export function warmupProblem(warmup: WarmupStatus): string {
  if (warmup.results.length === 0) return "no Claude login on this Mac to warm up";
  const missed = warmup.results.filter((result) => !result.ok);
  return missed.length === 0 ? "" : `not warmed up: ${missed.map((result) => `${result.login} (${result.error})`).join(", ")}`;
}

export function createActions(deps: ActionDeps): Actions {
  return {
    async set(input) {
      const controller = await deps.controller();
      const status = await controller.set(input);
      // A timer or On brings lid mode along when the switch is on; Off and While agents work end it.
      const lid = input.mode === "on" || input.mode === "timer" ? lidOnProblem(status) : lidOffProblem(status);
      return answer(status, { problem: join(lid, holdProblem(status)) });
    },

    async setOptions(patch) {
      const controller = await deps.controller();
      const before = controller.status();
      // Without the one-time permission the switch would only promise lid mode, so it is not
      // flipped: the page asks for the permission instead (client LidCard), and only a person
      // at the Mac can give it.
      if (patch.lidClosed === true && !before.lidClosed && before.lid.setup === "needs-setup") {
        return answer(before, { refused: NEEDS_SETUP });
      }
      const status = await controller.setOptions(patch);
      const lid = patch.lidClosed === true ? lidOnProblem(status) : patch.lidClosed === false ? lidOffProblem(status) : "";
      return answer(status, { problem: join(lid, holdProblem(status)) });
    },

    async sleep() {
      const controller = await deps.controller();
      // With sleep switched off system-wide `pmset sleepnow` does nothing: lid mode goes first,
      // and when it will not go, sleep is not asked for and the answer says why.
      if (deps.lid.status().on) await deps.lid.disable("sleep now", "sleep");
      const lid = deps.lid.status();
      if (lid.on) {
        return answer(controller.status(), {
          refused: `sleep is switched off system-wide and could not be switched back on: ${lid.error || "pmset still reports it off"}`,
        });
      }
      return answer(controller.sleep());
    },

    async lid({ lid }) {
      const controller = await deps.controller();
      if (lid === "off") {
        await deps.lid.disable("turned off", "off");
        const status = controller.status();
        return answer(status, { refused: status.lid.on ? `sleep is still switched off: ${status.lid.error || "pmset still reports it off"}` : "" });
      }
      // Lid mode rides on a timer or On with the switch on: without them there is nothing to
      // bring back, and syncLid would rather end lid mode Caffeine started.
      const before = controller.status();
      if (!lidWanted(before)) return answer(before, { refused: lidNotWanted(before) });
      const status = await controller.syncLid();
      return answer(status, { refused: status.lid.on ? "" : `lid mode did not come on: ${lidOffReason(status)}` });
    },

    async dismissHeat() {
      const controller = await deps.controller();
      const alert = controller.status().thermal.event;
      await deps.heat.dismiss();
      return answer(controller.status(), { refused: alert === null ? "there is no heat alert to dismiss" : "" });
    },

    async setWarmup(patch) {
      const controller = await deps.controller();
      // Hidden is off (index.server.ts switches it off whenever Settings hides it): switched on
      // here, it would message the accounts unseen until the next settings change.
      if (patch.enabled === true && deps.warmupHidden()) return answer(controller.status(), { refused: WARMUP_HIDDEN });
      await deps.warmup.set(patch);
      return answer(controller.status());
    },

    async runWarmup({ wait }) {
      const controller = await deps.controller();
      if (deps.warmup.status().running) {
        return answer(controller.status(), { refused: "a warm-up is already running; its results come with the status once it is done" });
      }
      const run = deps.warmup.runNow();
      if (!wait) {
        void run.catch((failure) => deps.log?.(`caffeine: warm-up failed: ${String(failure)}`));
        return answer(controller.status());
      }
      await run;
      return answer(controller.status(), { problem: warmupProblem(deps.warmup.status()) });
    },
  };
}
