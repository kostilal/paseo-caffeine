import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

export interface Keeper {
  active(): boolean;
  /** The last failure to start or stay running, or "" while all is well. */
  error(): string;
  pid(): number | null;
  /**
   * Starts the child unless one is running. `untilMs` adds `-t` as a second guard, and
   * `keepDisplay` adds `-d`. A running child is left alone, so changing either of these
   * means release() first — the caller decides that, because only it knows what changed.
   */
  hold(untilMs?: number, keepDisplay?: boolean): void;
  release(): void;
}

/** What the keeper needs from a child: enough for tests to hand in a stand-in. */
type Child = Pick<ChildProcess, "pid" | "kill" | "on">;
type Spawner = (command: string, args: readonly string[]) => Child;

export interface KeeperOptions {
  command?: string;
  args?: readonly string[];
  /** The process whose exit takes caffeinate down with it: this plugin's, by default. */
  guardPid?: number;
  now?: () => number;
  spawn?: Spawner;
  /** Where "<caffeinate pid> <plugin pid>" is written while a child runs, so the LaunchAgent
   *  guard can stop this caffeinate and no other (see heatShell in lid.server.ts). */
  pidFile?: string;
}

/**
 * `-i` holds off idle sleep on battery, `-s` holds off sleep on AC power; together they
 * are what Orca runs. `-w` ties the child to the plugin process, so if the daemon kills
 * this plugin without giving it a chance to clean up, caffeinate notices the parent is
 * gone and exits by itself instead of holding the Mac awake for good.
 *
 * `-d` is deliberately not in here: holding the display is the one thing this plugin
 * does not do by default, and it is added per hold() when the switch asks for it.
 */
const DEFAULT_ARGS = ["-i", "-s"] as const;

export function createKeeper(options: KeeperOptions = {}): Keeper {
  const command = options.command ?? "/usr/bin/caffeinate";
  const baseArgs = options.args ?? DEFAULT_ARGS;
  const guardPid = options.guardPid ?? process.pid;
  const now = options.now ?? Date.now;
  const spawn: Spawner = options.spawn ?? ((cmd, args) => nodeSpawn(cmd, [...args], { stdio: "ignore" }));

  let child: Child | null = null;
  let lastError = "";
  let releasing = false;

  return {
    active: () => child !== null,
    error: () => lastError,
    pid: () => child?.pid ?? null,

    hold(untilMs, keepDisplay = false) {
      if (child) return;
      const args = [...baseArgs];
      if (keepDisplay) args.push("-d");
      // Only the real caffeinate understands -w; a test's stand-in command gets its own args.
      if (options.args === undefined) args.push("-w", String(guardPid));
      if (untilMs !== undefined) {
        const seconds = Math.max(1, Math.ceil((untilMs - now()) / 1000));
        args.push("-t", String(seconds));
      }
      releasing = false;
      lastError = "";
      let started: Child;
      try {
        started = spawn(command, args);
      } catch (error) {
        lastError = `${command}: ${String(error)}`;
        return;
      }
      child = started;
      if (options.pidFile && started.pid) {
        try {
          writeFileSync(options.pidFile, `${started.pid} ${guardPid}\n`);
        } catch {
          // The guard then cannot stop it, and the plugin's own release still can.
        }
      }
      // Only while the file still names this child: a new one may already have replaced it.
      const forget = () => {
        if (!options.pidFile || !started.pid) return;
        try {
          if (readFileSync(options.pidFile, "utf8").startsWith(`${started.pid} `)) rmSync(options.pidFile, { force: true });
        } catch {
          // Already gone.
        }
      };
      started.on("exit", forget);
      started.on("error", (error: Error) => {
        // ENOENT and friends arrive here rather than from spawn() itself.
        lastError = `${command}: ${error.message}`;
        if (child === started) child = null;
      });
      started.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (child === started) child = null;
        // A release is the one exit that is not news.
        if (!releasing) lastError = `${command} exited with ${code ?? signal ?? "unknown"}`;
      });
    },

    release() {
      lastError = "";
      if (!child) return;
      releasing = true;
      const current = child;
      child = null;
      current.kill("SIGTERM");
    },
  };
}
