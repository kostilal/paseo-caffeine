import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FanReading } from "../shared/caffeine.shared.ts";
import { parseLidClosed } from "./lid.server.ts";
import { SENSORS_SOURCE } from "./sensors-source.ts";

/**
 * Where the heat guard's readings come from. Pressure and the battery come from tools every
 * Mac has, so the guard never depends on anything built; CPU and fans need the compiled
 * helper (server/sensors-source.ts), and only the page and the fan trigger miss it.
 */

const NOTIFYUTIL = "/usr/bin/notifyutil";
const IOREG = "/usr/sbin/ioreg";
const XCODE_SELECT = "/usr/bin/xcode-select";
const CLANG = "/usr/bin/clang";
export const PRESSURE_KEY = "com.apple.system.thermalpressurelevel";
export const BIN_DIR = join(homedir(), ".jobby-jobs", "bin");
/** A file of readings to show instead of the real ones, for looking at the page safely. */
export const SIMULATE_FILE = join(homedir(), ".jobby-jobs", "caffeine-thermal-simulate");

/** `com.apple.system.thermalpressurelevel 2` → 2; anything outside 0 … 4 is unreadable. */
export function parsePressure(output: string): number | null {
  const match = /thermalpressurelevel\s+(-?\d+)\s*$/m.exec(output);
  if (!match) return null;
  const level = Number(match[1]);
  return level >= 0 && level <= 4 ? level : null;
}

/** `"Temperature" = 3013` in AppleSmartBattery, hundredths of a degree → 30.1 °C. */
export function parseBatteryTemp(output: string): number | null {
  const match = /^\s*"Temperature" = (\d+)\s*$/m.exec(output);
  if (!match) return null;
  const celsius = Math.round(Number(match[1]) / 10) / 10;
  return celsius > 0 && celsius < 90 ? celsius : null;
}

export interface HidReading {
  name: string;
  value: number;
}

/**
 * The hottest die sensor, or null when there are not two sensible ones. Each sensor comes
 * from several PMU services, so readings are folded by name first; then anything outside
 * 10 … 120 °C goes (the "PMU tdev" sensors answer around −9200 on an M4 Pro), and so does a
 * value that three or more different sensors report to the hundredth — the placeholder parked
 * cores give (exelban/stats #3692) — before the maximum is taken.
 */
export function cpuFromSensors(readings: readonly HidReading[]): number | null {
  const byName = new Map<string, number>();
  for (const { name, value } of readings) {
    if (!/^PMU tdie\d+$/.test(name) && !/^[pe]ACC MTR Temp Sensor\d+$/.test(name) && !/^PMGR SOC Die Temp Sensor\d+$/.test(name)) continue;
    if (!Number.isFinite(value)) continue;
    byName.set(name, Math.max(byName.get(name) ?? -Infinity, value));
  }
  const sensible = [...byName.values()].filter((value) => value >= 10 && value <= 120);
  const seen = new Map<string, number>();
  for (const value of sensible) seen.set(value.toFixed(2), (seen.get(value.toFixed(2)) ?? 0) + 1);
  const real = sensible.filter((value) => (seen.get(value.toFixed(2)) ?? 0) < 3);
  return real.length >= 2 ? Math.round(Math.max(...real)) : null;
}

interface HelperFan {
  ac?: unknown;
  mn?: unknown;
  mx?: unknown;
  md?: unknown;
}

/**
 * The fans as the helper printed them: null when the SMC could not be opened, [] on a Mac
 * without fans. A fan whose maximum is missing or absurd is left out rather than guessed.
 * Mode 1 is a fan another app has taken over (Macs Fan Control and the like); 0 and 3 are
 * macOS's own.
 */
export function fansFromHelper(smc: unknown, fanCount: unknown, fans: unknown): FanReading[] | null {
  if (smc !== true || typeof fanCount !== "number" || fanCount < 0) return null;
  if (fanCount === 0) return [];
  const list = Array.isArray(fans) ? (fans as HelperFan[]) : [];
  return list
    .map((fan) => ({ rpm: Number(fan.ac), min: Number(fan.mn), max: Number(fan.mx), manual: Number(fan.md) === 1 }))
    .filter((fan) => fan.max > 0 && fan.max < 20_000 && fan.min >= 0 && fan.min <= fan.max && fan.rpm >= 0 && fan.rpm <= fan.max * 1.3);
}

export interface HelperReading {
  cpuC: number | null;
  fans: FanReading[] | null;
}

export function parseHelperOutput(text: string): HelperReading {
  const parsed = JSON.parse(text) as { hid?: unknown; smc?: unknown; fanCount?: unknown; fans?: unknown };
  const hid = Array.isArray(parsed.hid)
    ? (parsed.hid as Array<{ name?: unknown; value?: unknown }>).map((entry) => ({ name: String(entry.name ?? ""), value: Number(entry.value) }))
    : [];
  return { cpuC: cpuFromSensors(hid), fans: fansFromHelper(parsed.smc, parsed.fanCount, parsed.fans) };
}

export interface Simulation {
  /** Pretend lid mode is on, to see the guard's states without switching sleep off. */
  armed?: boolean;
  pressure?: number | null;
  batteryC?: number | null;
  cpuC?: number | null;
  fans?: FanReading[] | null;
  lidClosed?: boolean | null;
}

/**
 * The simulation file: `key=value` lines, any of
 *   pressure=0…4|none   battery=45.5|none   cpu=88|none   lid=open|closed   armed=1
 *   fans=rpm/min/max[,rpm/min/max…]|none|unknown
 * Keys left out keep their real readings. A simulated reading is never acted on (heat.server.ts).
 */
export function parseSimulation(text: string): Simulation {
  const out: Simulation = {};
  const number = (value: string) => (value === "none" ? null : Number.isFinite(Number(value)) ? Number(value) : undefined);
  for (const line of text.split("\n")) {
    const match = /^\s*([a-z]+)\s*=\s*(\S+)\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "pressure") {
      const level = number(value);
      if (level === null || (level !== undefined && level >= 0 && level <= 4)) out.pressure = level;
    } else if (key === "battery") {
      const celsius = number(value);
      if (celsius !== undefined) out.batteryC = celsius;
    } else if (key === "cpu") {
      const celsius = number(value);
      if (celsius !== undefined) out.cpuC = celsius;
    } else if (key === "lid") {
      if (value === "open" || value === "closed") out.lidClosed = value === "closed";
    } else if (key === "armed") {
      if (value === "1" || value === "0") out.armed = value === "1";
    } else if (key === "fans") {
      if (value === "unknown") out.fans = null;
      else if (value === "none") out.fans = [];
      else {
        out.fans = value.split(",").map((fan) => {
          const [rpm, min, max] = fan.split("/").map(Number);
          return { rpm: rpm ?? 0, min: min ?? 0, max: max ?? 0, manual: false };
        });
      }
    }
  }
  return out;
}

type Run = (command: string, args: readonly string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runCommand: Run = (command, args, timeoutMs = 5_000) =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs }, (failure, stdout, stderr) => {
      const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The helper's file name carries a hash of its source: an edited source builds anew. */
export function helperPath(source: string = SENSORS_SOURCE, dir: string = BIN_DIR): string {
  return join(dir, `caffeine-sensors-${createHash("sha256").update(source).digest("hex").slice(0, 10)}`);
}

export type HelperState = { path: string } | { reason: "no-toolchain" | "build-failed" | "unsupported" };

/**
 * Builds the helper once, if it is not there. `xcode-select -p` comes first: on a Mac
 * without the command-line tools, running clang would pop up the dialog that offers to
 * install them, and the plugin has no business doing that. Older builds are removed.
 */
export async function ensureHelper(options: { run?: Run; dir?: string; source?: string; log?: (line: string) => void } = {}): Promise<HelperState> {
  const run = options.run ?? runCommand;
  const dir = options.dir ?? BIN_DIR;
  const source = options.source ?? SENSORS_SOURCE;
  const log = options.log ?? (() => undefined);
  if (process.platform !== "darwin") return { reason: "unsupported" };
  const path = helperPath(source, dir);
  try {
    await access(path, constants.X_OK);
    return { path };
  } catch {
    // Not built yet.
  }
  const tools = await run(XCODE_SELECT, ["-p"]);
  if (tools.code !== 0) return { reason: "no-toolchain" };
  await mkdir(dir, { recursive: true });
  const file = `${path}.c`;
  await writeFile(file, source);
  const built = await run(CLANG, ["-O2", "-o", path, file, "-framework", "IOKit", "-framework", "CoreFoundation"], 120_000);
  await rm(file, { force: true });
  if (built.code !== 0) {
    log(`caffeine: sensor helper did not build: ${built.stderr.trim().split("\n").slice(-3).join(" ")}`);
    await rm(path, { force: true });
    return { reason: "build-failed" };
  }
  await chmod(path, 0o755);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith("caffeine-sensors-") && join(dir, name) !== path) await rm(join(dir, name), { force: true });
  }
  log(`caffeine: sensor helper built at ${path}`);
  return { path };
}

export interface Reading {
  pressure: number | null;
  batteryC: number | null;
  cpuC: number | null;
  fans: FanReading[] | null;
  lidClosed: boolean | null;
  /** "" when the helper ran, else why CPU and fans are missing. */
  sensors: string;
  simulated: boolean;
  /** Only from a simulation: lid mode as the simulation says, instead of the real one. */
  armed?: boolean;
}

export interface HeatSensors {
  read(): Promise<Reading>;
  /** The helper's path once it is built, for the sh guard; "" until then. */
  helper(): string;
}

/** The real thing. The helper is built in the background on first use; readings go on without it. */
export function systemHeatSensors(log: (line: string) => void, run: Run = runCommand, simulateFile: string = SIMULATE_FILE): HeatSensors {
  let state: HelperState | null = null;
  let building: Promise<void> | null = null;
  const build = () => {
    building ??= ensureHelper({ run, log })
      .then((result) => void (state = result))
      .catch((failure) => {
        log(`caffeine: sensor helper failed: ${String(failure)}`);
        state = { reason: "build-failed" };
      });
    return building;
  };

  return {
    helper: () => (state && "path" in state ? state.path : ""),
    async read() {
      if (state === null) void build();
      const [pressure, battery, lid, helper, simulation] = await Promise.all([
        run(NOTIFYUTIL, ["-g", PRESSURE_KEY]),
        run(IOREG, ["-rn", "AppleSmartBattery"]),
        run(IOREG, ["-r", "-k", "AppleClamshellState", "-d", "4"]),
        state && "path" in state ? run(state.path, []) : Promise.resolve(null),
        readFile(simulateFile, "utf8").then(parseSimulation, () => null),
      ]);
      let fromHelper: HelperReading = { cpuC: null, fans: null };
      let sensors = state === null ? "building" : "path" in state ? "" : state.reason;
      if (helper) {
        try {
          if (helper.code !== 0) throw new Error(`exit ${helper.code}`);
          fromHelper = parseHelperOutput(helper.stdout);
        } catch (failure) {
          sensors = "unreadable";
          log(`caffeine: sensor helper output unreadable: ${String(failure)}`);
        }
      }
      const real: Reading = {
        pressure: pressure.code === 0 ? parsePressure(pressure.stdout) : null,
        batteryC: battery.code === 0 ? parseBatteryTemp(battery.stdout) : null,
        cpuC: fromHelper.cpuC,
        fans: fromHelper.fans,
        lidClosed: lid.code === 0 ? parseLidClosed(lid.stdout) : null,
        sensors,
        simulated: false,
      };
      if (!simulation) return real;
      return { ...real, ...simulation, simulated: true };
    },
  };
}
