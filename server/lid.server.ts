import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Battery, LidSetup, LidStatus, LidStopped } from "../shared/caffeine.shared.ts";

/**
 * Lid mode: the Mac keeps running with the lid closed and no display attached, for a while.
 *
 * `caffeinate` cannot do this — a closed lid sleeps a MacBook whatever holds it — so this
 * flips the system-wide `pmset disablesleep` switch, which needs root. A sudoers rule set up
 * once allows exactly the two commands below and nothing else, so the plugin can flip it
 * from anywhere, the phone included, and flip it back on its own.
 *
 * A Mac that never sleeps in a closed bag heats up and drains, so getting back to normal is
 * the part built to hold: the plugin's own deadline, a guard that restores sleep at the
 * deadline even if Paseo is gone by then (a LaunchAgent, so it also runs again after a reboot,
 * at login), a low-battery cut-off, and a check on every start. State is only let go once
 * `pmset -g` confirms sleep is back; what the tile shows is read from there, never assumed.
 */

const PMSET = "/usr/bin/pmset";
const IOREG = "/usr/sbin/ioreg";
const PROFILER = "/usr/sbin/system_profiler";
const SUDO = "/usr/bin/sudo";
export const SUDOERS_FILE = "/etc/sudoers.d/paseo-caffeine";
export const LID_FILE = join(homedir(), ".jobby-jobs", "caffeine-lid.json");
/** Below this, on battery, lid mode ends by itself. */
export const LID_LOW_BATTERY = 20;
/** The guard fires this long after the deadline, so the plugin's own tick normally wins. */
const GUARD_GRACE_MS = 60_000;
export const GUARD_LABEL = "com.paseo.caffeine.lid-guard";
export const GUARD_PLIST = join(homedir(), "Library", "LaunchAgents", `${GUARD_LABEL}.plist`);

const ON = ["-a", "disablesleep", "1"] as const;
const OFF = ["-a", "disablesleep", "0"] as const;

/** The one sudoers line: these two exact commands, for this user, and nothing else. */
export function sudoersRule(user: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) throw new Error(`unexpected user name: ${user}`);
  return `${user} ALL=(root) NOPASSWD: ${PMSET} ${ON.join(" ")}, ${PMSET} ${OFF.join(" ")}`;
}

/**
 * Run as root once. The rule is checked by visudo before it is put in place, so a bad line
 * can never land in /etc/sudoers.d and lock sudo up.
 */
export function setupScript(rule: string): string {
  return [
    "set -e",
    'tmp="$(/usr/bin/mktemp)"',
    `/usr/bin/printf '%s\\n' '${rule}' > "$tmp"`,
    '/usr/sbin/visudo -cf "$tmp" >/dev/null',
    `/usr/bin/install -m 0440 -o root -g wheel "$tmp" ${SUDOERS_FILE}`,
    '/bin/rm -f "$tmp"',
    "",
  ].join("\n");
}

/**
 * The guard: a LaunchAgent that waits for the deadline, restores sleep and removes itself.
 * RunAtLoad makes launchd start it again at the next login after a reboot, when the wait is
 * whatever is left (or none).
 */
export function guardPlist(untilMs: number): string {
  const at = Math.ceil(untilMs / 1000);
  const plist = `'${GUARD_PLIST.replace(/'/g, "'\\''")}'`;
  // Up to half an hour of attempts, a minute apart; it removes itself only once `pmset -g`
  // shows sleep is back, or when it has run out of attempts.
  const script = [
    `left=$((${at} - $(/bin/date +%s)))`,
    'if [ "$left" -gt 0 ]; then /bin/sleep "$left"; fi',
    "i=0",
    `while [ "$i" -lt 30 ]; do ${SUDO} -n ${PMSET} ${OFF.join(" ")}; if ${PMSET} -g | /usr/bin/grep -q 'SleepDisabled[[:space:]]*0'; then break; fi; i=$((i + 1)); /bin/sleep 60; done`,
    `/bin/rm -f ${plist}`,
    `/bin/launchctl bootout gui/$(/usr/bin/id -u)/${GUARD_LABEL}`,
  ].join("; ");
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${GUARD_LABEL}</string>`,
    "<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>",
    `<string>${escape(script)}</string></array>`,
    "<key>RunAtLoad</key><true/>",
    "</dict></plist>",
    "",
  ].join("\n");
}

/** `SleepDisabled 1` in `pmset -g`; null when the line is not there. */
export function parseSleepDisabled(output: string): boolean | null {
  const match = /^\s*SleepDisabled\s+(\d)/m.exec(output);
  return match ? match[1] === "1" : null;
}

export interface LidStored {
  /** RFC 3339 deadline, or "" when lid mode is off or has no end. */
  until: string;
  /** The length that was picked, so the tile can count down from it; 0 when off. */
  minutes: number;
  /** On with no end: only a person, a low battery or heat turns it off. */
  forever: boolean;
}

const OFF_STATE: LidStored = { until: "", minutes: 0, forever: false };

const lidStored = z.object({
  until: z.string().default(""),
  minutes: z.number().int().nonnegative().default(0),
  forever: z.boolean().default(false),
});

/**
 * Whether `system_profiler SPDisplaysDataType -json` lists a display other than the built-in
 * one. `displaysleepnow` sleeps every display, so with a monitor in use the lid is left alone.
 * Output that cannot be read counts as external: leaving a lit panel beats blanking a monitor.
 */
export function externalDisplay(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { SPDisplaysDataType?: Array<{ spdisplays_ndrvs?: Array<{ spdisplays_connection_type?: string }> }> };
    const displays = (parsed.SPDisplaysDataType ?? []).flatMap((gpu) => gpu.spdisplays_ndrvs ?? []);
    if (displays.length === 0) return true;
    return displays.some((display) => display.spdisplays_connection_type !== "spdisplays_internal");
  } catch {
    return true;
  }
}

/** `"AppleClamshellState" = Yes` in `ioreg -r -k AppleClamshellState`; null when not there. */
export function parseLidClosed(output: string): boolean | null {
  const match = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(output);
  return match ? match[1] === "Yes" : null;
}

/**
 * Whether `pmset -g therm` reports the Mac running hot: a thermal or performance warning level
 * above 0 that is recorded (macOS prints "Note: No … has been recorded" otherwise), or the CPU
 * held below full speed. Read loosely on purpose: a false alarm only turns lid mode off.
 */
export function thermalWarning(output: string): boolean {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (/^Note: No /i.test(line)) continue;
    if (/warning level/i.test(line)) {
      // A recorded level of 0 is the all-clear after a warm spell; a level that cannot be read
      // counts as hot.
      const level = /warning level[^0-9]*(\d+)/i.exec(line);
      if (level === null || Number(level[1]) > 0) return true;
      continue;
    }
    const limit = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(line);
    if (limit !== null && Number(limit[1]) < 100) return true;
  }
  return false;
}

export async function readLid(path: string = LID_FILE): Promise<LidStored> {
  try {
    const parsed = lidStored.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : { ...OFF_STATE };
  } catch {
    return { ...OFF_STATE };
  }
}

export async function writeLid(value: LidStored, path: string = LID_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export interface LidDeps {
  /** Runs a command, never asking for a password; resolves with its exit code and output. */
  run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }>;
  /** Runs a shell script as root through macOS's own password (or Touch ID) dialog. */
  admin(script: string): Promise<void>;
  /** Arms the guard to restore sleep at `untilMs`, replacing any earlier one; false if it
   *  could not be armed. */
  startGuard(untilMs: number): Promise<boolean>;
  /** Disarms the guard, if there is one. */
  stopGuard(): Promise<void>;
  read(): Promise<LidStored>;
  write(value: LidStored): Promise<void>;
  user(): string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Lid {
  start(): Promise<void>;
  /** Re-reads the system and ends lid mode at its deadline or on a low battery. */
  tick(battery: Battery | null): Promise<void>;
  /** `untilMs` sets the deadline outright, so lid mode ends with the timer it rides on;
   *  `minutes` is then the length the tile counts down from. */
  enable(minutes: number | "forever", untilMs?: number): Promise<void>;
  /** `by` says who turned it off, for the tile: "sleep" (Sleep now) or "off" (the header). */
  disable(why: string, by?: LidStopped): Promise<void>;
  setup(): Promise<void>;
  /** Keeps the display asleep while the lid is closed and lid mode is on, checked once a
   *  minute; never while an external monitor is attached. */
  checkClosed(): Promise<void>;
  status(): LidStatus;
}

export function createLid(deps: LidDeps): Lid {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);

  let stored: LidStored = { ...OFF_STATE };
  let setup: LidSetup = "unknown";
  /** From `pmset -g`; null when it could not be read, which is not the same as off. */
  let on: boolean | null = null;
  let error = "";

  // One operation at a time: the timer, a mode change and two clients can all reach here, and
  // a "turn off" overtaken by a "turn on" must not undo the new deadline.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  }

  /** The deadline, or 0 (already due) when it is missing or does not parse. */
  const deadline = () => {
    const at = Date.parse(stored.until);
    return Number.isNaN(at) ? 0 : at;
  };

  async function readPermission(): Promise<void> {
    const allowed = await deps.run(SUDO, ["-n", "-l", PMSET, ...ON]).catch(() => ({ code: 1, stdout: "" }));
    setup = allowed.code === 0 ? "ready" : "needs-setup";
  }

  async function readSleep(): Promise<void> {
    const settings = await deps.run(PMSET, ["-g"]).catch(() => ({ code: 1, stdout: "" }));
    on = settings.code === 0 ? parseSleepDisabled(settings.stdout) : null;
  }

  async function pmset(args: readonly string[]): Promise<void> {
    const result = await deps.run(SUDO, ["-n", PMSET, ...args]);
    if (result.code !== 0) throw new Error(`pmset ${args.join(" ")} failed (exit ${result.code})`);
  }

  async function save(next: LidStored): Promise<void> {
    stored = next;
    await deps.write(stored);
  }

  /** The lid as last seen, to log its changes and look for a monitor once per closing. */
  let wasClosed = false;
  /** Whether a monitor other than the built-in one was in use at this closing; null: not asked. */
  let externalSeen: boolean | null = null;

  /** Why lid mode last ended on its own, for the tile; cleared when it is turned on again. */
  let ended: "" | "battery" | "heat" = "";
  /** Who else turned it off, for the tile; cleared the same way. At most one of the two is
   *  set: the latest reason replaces any earlier one, so the tile never names a stale one. */
  let stopped: LidStopped | "" = "";
  const because = (why: { ended?: "battery" | "heat"; stopped?: LidStopped }) => {
    ended = why.ended ?? "";
    stopped = why.stopped ?? "";
  };

  /** Whether lid mode is on by Caffeine's own record: timed or forever. */
  const running = () => stored.until !== "" || stored.forever;

  async function hot(): Promise<boolean> {
    const answer = await deps.run(PMSET, ["-g", "therm"]).catch(() => ({ code: 1, stdout: "" }));
    return answer.code === 0 && thermalWarning(answer.stdout);
  }

  /** Sleep back on. The deadline and the guard are only let go once the system confirms it;
   *  until then the next tick tries again and the guard stays armed. */
  async function restore(why: string): Promise<void> {
    let failed = "";
    try {
      await pmset(OFF);
    } catch (failure) {
      failed = failure instanceof Error ? failure.message : String(failure);
    }
    await readSleep();
    // Back on, whoever did it (a failed command next to a Mac put right by hand included).
    if (on !== false) {
      error = failed || (on === null ? "could not read whether sleep is back" : "sleep is still switched off");
      log(`caffeine: lid mode could not be turned off (${why}): ${error}`);
      return;
    }
    error = "";
    await deps.stopGuard().catch(() => undefined);
    await save(OFF_STATE);
    log(`caffeine: lid mode off (${why})`);
  }

  return {
    start: () =>
      serial(async () => {
        stored = await deps.read();
        await readPermission();
        await readSleep();
        if (!running()) return;
        if (stored.forever) {
          // Turned back on while Paseo was down: nothing to keep.
          if (on === false) await save(OFF_STATE);
          return;
        }
        // A deadline that passed while Paseo was down: put sleep back now.
        if (deadline() <= now()) return restore("deadline passed while stopped");
        // Still running: re-arm the guard, in case the one from before did not survive.
        if (!(await deps.startGuard(deadline() + GUARD_GRACE_MS))) await restore("guard could not be armed");
      }),

    tick: (battery) =>
      serial(async () => {
        await readSleep();
        if (!running()) return;
        if (!stored.forever && deadline() <= now()) return restore("time is up");
        if (battery !== null && !battery.external && battery.percent < LID_LOW_BATTERY) {
          await restore(`battery at ${battery.percent}%`);
          if (!running()) because({ ended: "battery" });
          return;
        }
        if (await hot()) {
          await restore("the Mac is running hot");
          if (!running()) because({ ended: "heat" });
          return;
        }
        // Turned back on by hand (`pmset -a disablesleep 0`): nothing left to time.
        if (on === false) {
          await deps.stopGuard().catch(() => undefined);
          await save(OFF_STATE);
          because({ stopped: "manual" });
        }
      }),

    enable: (minutes, untilMs) =>
      serial(async () => {
        // A new attempt: whatever turned lid mode off before is no longer the news, even if
        // this one fails (its failure is shown on its own).
        because({});
        await readPermission();
        if (setup !== "ready") {
          error = "needs-setup";
          return;
        }
        if (minutes === "forever") {
          // No end, so no guard: the battery and heat checks, and a person, turn it off. A
          // timer's guard is stopped only once sleep is switched off for good, so a failure
          // here leaves the timed session as it was.
          try {
            await pmset(ON);
          } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
            await readSleep();
            return;
          }
          await deps.stopGuard().catch(() => undefined);
          error = "";
          // A lid already closed when lid mode comes on counts as just closed.
          wasClosed = false;
          externalSeen = null;
          await save({ until: "", minutes: 0, forever: true });
          await readSleep();
          log("caffeine: lid mode on with no end");
          return;
        }
        const until = untilMs ?? now() + minutes * 60_000;
        // The guard first: sleep is never switched off without something set to bring it back.
        if (!(await deps.startGuard(until + GUARD_GRACE_MS))) {
          error = "could not arm the timer that turns this off (is Caffeine's background item allowed in System Settings → General → Login Items?)";
          return;
        }
        try {
          await pmset(ON);
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
          await deps.stopGuard().catch(() => undefined);
          await readSleep();
          return;
        }
        error = "";
        wasClosed = false;
        externalSeen = null;
        await save({ until: new Date(until).toISOString(), minutes, forever: false });
        await readSleep();
        log(`caffeine: lid mode on for ${minutes} min`);
      }),

    disable: (why, by) =>
      serial(async () => {
        await restore(why);
        // Only once sleep is confirmed back: a turn-off that did not take names no one. A
        // mode change (no `by`) clears the reason, since the tile has nothing to explain then.
        if (on === false) because(by ? { stopped: by } : {});
      }),

    // Outside the queue on purpose: the password dialog waits for a person, possibly minutes,
    // and the ticks behind it (which the whole controller waits on) must not. It only touches
    // `setup` and `error`.
    async setup() {
      try {
        await deps.admin(setupScript(sudoersRule(deps.user())));
        error = "";
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        // Cancelling the password dialog is a choice, not a failure.
        error = /-128|cancel/i.test(message) ? "" : message;
      }
      await readPermission();
    },

    async checkClosed() {
      const seen = await deps.run(IOREG, ["-r", "-k", "AppleClamshellState", "-d", "4"]).catch(() => ({ code: 1, stdout: "" }));
      const read = parseLidClosed(seen.stdout);
      // Unknown is neither: nothing changes until the lid can be read again.
      if (seen.code !== 0 || read === null) return;
      const justClosed = read && !wasClosed;
      if (read !== wasClosed) {
        log(`caffeine: lid ${read ? "closed" : "opened"}`);
        externalSeen = null;
      }
      wasClosed = read;
      if (!read || !running() || on !== true) return;
      // A monitor found stays found until the lid opens. "None" is asked again every time: one
      // plugged in after the lid closed must not be blanked every minute.
      if (externalSeen !== true) {
        const displays = await deps.run(PROFILER, ["SPDisplaysDataType", "-json"]).catch(() => ({ code: 1, stdout: "" }));
        externalSeen = displays.code !== 0 || externalDisplay(displays.stdout);
      }
      if (externalSeen) return;
      // Every check while the lid stays shut, not only on closing: whatever wakes the panel
      // under a closed lid (a missed closing, a notification) is put right within a minute. A
      // display already asleep is left as it is.
      await deps.run(PMSET, ["displaysleepnow"]).catch(() => undefined);
      if (justClosed) log("caffeine: lid closed, display put to sleep");
    },

    status: () => ({ on: on === true, until: stored.until, minutes: stored.minutes, forever: stored.forever, ended, stopped, setup, error }),
  };
}

function runCommand(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 10_000 }, (failure, stdout) => {
      const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

/** The real thing: execFile, osascript, a detached sh, and `ps` to recognise our own guard. */
export function systemLidDeps(log: (line: string) => void): LidDeps {
  return {
    run: runCommand,
    admin: async (script) => {
      const dir = await mkdtemp(join(tmpdir(), "caffeine-lid-"));
      const file = join(dir, "setup.sh");
      try {
        await writeFile(file, script, { mode: 0o700 });
        const prompt = "Caffeine wants to let this Mac keep running with the lid closed. This allows only that one power setting.";
        const quoted = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const apple = `do shell script "/bin/sh " & quoted form of "${quoted}" with prompt "${prompt}" with administrator privileges`;
        await new Promise<void>((resolve, reject) => {
          execFile("/usr/bin/osascript", ["-e", apple], { timeout: 5 * 60_000 }, (failure, _out, stderr) =>
            failure ? reject(new Error(String(stderr).trim() || failure.message)) : resolve(),
          );
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    startGuard: async (untilMs) => {
      try {
        const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
        await runCommand("/bin/launchctl", ["bootout", `${domain}/${GUARD_LABEL}`]);
        await mkdir(dirname(GUARD_PLIST), { recursive: true });
        await writeFile(GUARD_PLIST, guardPlist(untilMs), { mode: 0o644 });
        const loaded = await runCommand("/bin/launchctl", ["bootstrap", domain, GUARD_PLIST]);
        if (loaded.code !== 0) log(`caffeine: lid guard did not load (exit ${loaded.code})`);
        return loaded.code === 0;
      } catch (failure) {
        log(`caffeine: lid guard failed: ${String(failure)}`);
        return false;
      }
    },
    stopGuard: async () => {
      const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
      await runCommand("/bin/launchctl", ["bootout", `${domain}/${GUARD_LABEL}`]);
      await rm(GUARD_PLIST, { force: true });
    },
    read: () => readLid(),
    write: (value) => writeLid(value),
    user: () => userInfo().username,
    log,
  };
}
