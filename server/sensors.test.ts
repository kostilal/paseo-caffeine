import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SENSORS_SOURCE } from "./sensors-source.ts";
import {
  cpuFromSensors,
  ensureHelper,
  fansFromHelper,
  helperPath,
  parseBatteryTemp,
  parseHelperOutput,
  parsePressure,
  parseSimulation,
  systemHeatSensors,
} from "./sensors.server.ts";

/** What the helper printed on a 16-inch M4 Pro at rest (2026-10-24), cut down: each die
 *  sensor three times from three PMU services, the tdev ones answering nonsense. */
const M4_PRO = JSON.stringify({
  hid: [
    { name: "PMU tdie1", value: 39.25 },
    { name: "PMU tdie1", value: 39.25 },
    { name: "PMU tdie1", value: 38.93 },
    { name: "PMU tdie2", value: 43.73 },
    { name: "PMU tdie2", value: 43.73 },
    { name: "PMU tdie3", value: 42.37 },
    { name: "PMU tdev1", value: -9199.43 },
    { name: "PMU tdev2", value: -9201.14 },
    { name: "NAND CH0 temp", value: 32 },
    { name: "gas gauge battery", value: 28.1 },
  ],
  smc: true,
  fanCount: 2,
  fans: [
    { ac: 0, mn: 1350, mx: 5777, md: 3 },
    { ac: 0, mn: 1350, mx: 5777, md: 3 },
  ],
});

test("pressure: notifyutil's line, 0 … 4 only", () => {
  assert.equal(parsePressure("com.apple.system.thermalpressurelevel 0\n"), 0);
  assert.equal(parsePressure("com.apple.system.thermalpressurelevel 3"), 3);
  assert.equal(parsePressure("com.apple.system.thermalpressurelevel 9"), null);
  assert.equal(parsePressure("com.apple.system.thermalpressurelevel -1"), null);
  assert.equal(parsePressure(""), null);
});

test("battery temperature: the top-level key in hundredths, nothing nested, nothing absurd", () => {
  assert.equal(parseBatteryTemp('    "Temperature" = 3013\n    "VirtualTemperature" = 2809\n'), 30.1);
  assert.equal(parseBatteryTemp('    "Temperature" = 4512\n'), 45.1);
  assert.equal(parseBatteryTemp('    "BatteryData" = {"Temperature"=3000}\n'), null);
  assert.equal(parseBatteryTemp('    "Temperature" = 0\n'), null);
  assert.equal(parseBatteryTemp('    "Temperature" = 12000\n'), null);
});

test("CPU: the hottest die sensor, folded by name, garbage and placeholders out, two needed", () => {
  assert.equal(parseHelperOutput(M4_PRO).cpuC, 44);
  assert.equal(cpuFromSensors([{ name: "PMU tdie1", value: 60 }]), null, "one sensor is not enough");
  assert.equal(cpuFromSensors([{ name: "PMU tdev1", value: 50 }, { name: "PMU tdev2", value: 55 }]), null, "tdev is not a die sensor");
  assert.equal(
    cpuFromSensors([
      { name: "PMU tdie1", value: 40 },
      { name: "PMU tdie2", value: 40 },
      { name: "PMU tdie3", value: 40 },
      { name: "PMU tdie4", value: 52.5 },
      { name: "PMU tdie5", value: 51.1 },
    ]),
    53,
    "three sensors stuck on 40.00 are parked cores",
  );
  assert.equal(cpuFromSensors([{ name: "PMU tdie1", value: 130 }, { name: "PMU tdie2", value: 5 }]), null);
  assert.equal(cpuFromSensors([{ name: "pACC MTR Temp Sensor0", value: 61 }, { name: "eACC MTR Temp Sensor1", value: 48 }]), 61, "M1/M2 names");
});

test("fans: null without an SMC, [] without fans, absurd fans dropped, mode 1 is someone else's", () => {
  assert.deepEqual(parseHelperOutput(M4_PRO).fans, [
    { rpm: 0, min: 1350, max: 5777, manual: false },
    { rpm: 0, min: 1350, max: 5777, manual: false },
  ]);
  assert.equal(fansFromHelper(false, -1, []), null);
  assert.deepEqual(fansFromHelper(true, 0, []), []);
  assert.deepEqual(fansFromHelper(true, 1, [{ ac: 3000, mn: 1200, mx: 0, md: 0 }]), [], "no maximum, no fan");
  assert.equal(fansFromHelper(true, 1, [{ ac: 3000, mn: 1200, mx: 6000, md: 1 }])?.[0]?.manual, true);
});

test("the simulation file overrides what it names and nothing else", () => {
  assert.deepEqual(parseSimulation("pressure=2\nbattery=46.5\nlid=closed\n"), { pressure: 2, batteryC: 46.5, lidClosed: true });
  assert.deepEqual(parseSimulation("pressure=none\nbattery=none\nfans=unknown\n"), { pressure: null, batteryC: null, fans: null });
  assert.deepEqual(parseSimulation("fans=5000/1350/5777,4900/1350/5777\n").fans?.map((fan) => fan.rpm), [5000, 4900]);
  assert.deepEqual(parseSimulation("pressure=7\nlid=ajar\n# comment\n"), {});
});

test("the helper is built once, only with the command-line tools, and an edited source gets a new name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caffeine-helper-"));
  try {
    const calls: string[] = [];
    const noTools = await ensureHelper({ dir, run: async (command) => (calls.push(command), { code: 2, stdout: "", stderr: "" }) });
    assert.deepEqual(noTools, { reason: "no-toolchain" });
    assert.deepEqual(calls, ["/usr/bin/xcode-select"], "clang is never run without the tools: it would offer to install them");
    const built = await ensureHelper({
      dir,
      source: "int main(void) { return 0; }",
      run: async (command, args) => {
        if (command === "/usr/bin/clang") writeFileSync(args[args.indexOf("-o") + 1] as string, "#!/bin/sh\n");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.ok("path" in built && built.path === helperPath("int main(void) { return 0; }", dir));
    assert.notEqual(helperPath("a", dir), helperPath("b", dir));
    const failed = await ensureHelper({ dir, source: "broken", run: async (command) => ({ code: command === "/usr/bin/clang" ? 1 : 0, stdout: "", stderr: "error" }) });
    assert.deepEqual(failed, { reason: "build-failed" });
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".c")), [], "the source does not linger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a simulated reading is marked simulated, so it is never acted on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caffeine-sim-"));
  try {
    const file = join(dir, "simulate");
    writeFileSync(file, "pressure=3\nlid=closed\n");
    const run = async (command: string) =>
      command.endsWith("notifyutil")
        ? { code: 0, stdout: "com.apple.system.thermalpressurelevel 0\n", stderr: "" }
        : { code: 0, stdout: '    "Temperature" = 3100\n', stderr: "" };
    const reading = await systemHeatSensors(() => undefined, async (command) => (command.endsWith("xcode-select") ? { code: 2, stdout: "", stderr: "" } : run(command)), file).read();
    assert.equal(reading.pressure, 3);
    assert.equal(reading.batteryC, 31);
    assert.equal(reading.simulated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const hasTools = (() => {
  try {
    execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" });
    return existsSync("/usr/bin/clang");
  } catch {
    return false;
  }
})();

test("on this Mac, read-only: the real helper builds and reads temperatures and fans", { skip: !hasTools && "no command-line tools" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "caffeine-helper-real-"));
  try {
    const built = await ensureHelper({ dir });
    assert.ok("path" in built, JSON.stringify(built));
    const reading = parseHelperOutput(execFileSync(built.path, [], { encoding: "utf8" }));
    assert.ok(reading.cpuC === null || (reading.cpuC >= 10 && reading.cpuC <= 120), `cpu ${reading.cpuC}`);
    assert.ok(reading.fans === null || Array.isArray(reading.fans));
    const pct = execFileSync(built.path, ["--fans-pct"], { encoding: "utf8" }).trim();
    assert.match(pct, /^(\d+|none|unknown)$/);
    assert.equal(SENSORS_SOURCE.includes("${"), false, "no template holes in the C source");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
