import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatteryProbe, parseBattery, parsePower } from "./battery.server.ts";

/** Copied from a MacBook Pro on the charger, tab and all. */
const CHARGED = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34930787)\t100%; charged; 0:00 remaining present: true
`;

const NO_WATTS = { adapterWatts: null, inputWatts: null, batteryWatts: null };

/**
 * Trimmed `ioreg -rw0 -c AppleSmartBattery`. The layout (one-line dictionaries, the
 * unsigned amperage, the nested "Voltage" in BatteryData) is the one this Mac prints off
 * the charger; the charger's dictionary is made up, with the nested menu a USB-C charger
 * carries placed before "Watts", and a raw rating that differs so a wrong read shows.
 */
const IOREG_CHARGING = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 7>
    {
      "AppleRawAdapterDetails" = ({"Watts"=60})
      "Amperage" = 3000
      "ExternalConnected" = Yes
      "BatteryData" = {"Voltage"=99999,"CellVoltage"=(4200,4210,4205)}
      "AdapterDetails" = {"AdapterID"=0,"UsbHvcMenu"=({"Index"=0,"MaxVoltage"=5000,"MaxCurrent"=3000},{"Index"=1,"MaxVoltage"=20000,"MaxCurrent"=4700}),"Watts"=96,"Name"="96W USB-C Power Adapter","Voltage"=20000,"Current"=4800,"Description"="pd charger","FamilyCode"=18446744073172697098}
      "PowerTelemetryData" = {"WallEnergyEstimate"=0,"SystemLoad"=23100,"SystemPowerIn"=61432,"BatteryPower"=38000,"SystemVoltageIn"=20100}
      "IsCharging" = Yes
      "Voltage" = 12650
    }
`;

/** The same Mac off the charger, as printed: no watts for the adapter, nothing coming in. */
const IOREG_DISCHARGING = `+-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "AppleRawAdapterDetails" = ()
      "Amperage" = 18446744073709549360
      "ExternalConnected" = No
      "AdapterDetails" = {"FamilyCode"=0}
      "PowerTelemetryData" = {"SystemLoad"=27135,"SystemVoltageIn"=0,"SystemPowerIn"=0}
      "IsCharging" = No
      "Voltage" = 11791
    }
`;

/** The entry's children as macOS 27.2 lists them, after its properties. */
const CHILDREN = [
  "  | ", // the line between the properties and the children keeps a space after its guide
  "  +-o AppleSmartBatteryPack  <class AppleSmartBatteryPack, id 0x100000b6f, registered, matched, active, busy 0 (2 ms), retain 9>",
  "  | +-o AppleSmartBatteryBank  <class AppleSmartBatteryBank, id 0x100000b70, registered, matched, active, busy 0 (0 ms), retain 8>",
  "  | | +-o AppleSmartBatteryCell  <class AppleSmartBatteryCell, id 0x100000b71, registered, matched, active, busy 0 (0 ms), retain 6>",
  "  +-o AppleChargerData  <class AppleChargerData, id 0x100000b7c, registered, matched, active, busy 0 (0 ms), retain 6>",
  "",
].join("\n");

/**
 * `ioreg -rw0 -c AppleSmartBattery` as macOS 27.2 prints it, trimmed, with this Mac's own values
 * on the charger and a full battery. The entry has children now, and an entry with children is
 * printed with the tree's guides in front of every line.
 */
const IOREG_27_2 = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000b5b, registered, matched, active, busy 0 (3 ms), retain 11>
  | {
  |   "ExternalConnected" = Yes
  |   "AdapterDetails" = {"IsWireless"=No,"AdapterID"=0,"AdapterVoltage"=20000,"FamilyCode"=18446744073172697098,"AdapterPowerTier"=2,"Watts"=90,"UsbHvcHvcIndex"=3,"Current"=4500,"PMUConfiguration"=4460,"UsbHvcMenu"=({"Index"=0,"MaxCurrent"=3000,"MaxVoltage"=5000},{"Index"=3,"MaxCurrent"=4500,"MaxVoltage"=20000})}
  |   "Voltage" = 12899
  |   "PowerTelemetryData" = {"SystemPowerInAccumulatorCount"=54314,"SystemLoad"=13320,"SystemVoltageIn"=19840,"SystemPowerIn"=13320,"AccumulatedSystemPowerIn"=40225844131,"BatteryPower"=0}
  |   "Amperage" = 0
  |   "IsCharging" = No
  | }
${CHILDREN}`;

/**
 * Trimmed from a real capture on macOS 27.2, seconds after the charger went in: the power field
 * still reads 0, the current and voltage beside it are real, the battery's figures are the old ones.
 */
const IOREG_27_2_PLUGGED_IN = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000b5b, registered, matched, active, busy 0 (3 ms), retain 11>
  | {
  |   "ExternalConnected" = Yes
  |   "AdapterDetails" = {"IsWireless"=No,"AdapterID"=0,"AdapterVoltage"=20000,"AdapterPowerTier"=2,"Watts"=65,"Current"=3250,"Description"="pd charger"}
  |   "Voltage" = 11315
  |   "PowerTelemetryData" = {"SystemPowerInAccumulatorCount"=259977,"SystemLoad"=18446744073709488698,"SystemCurrentIn"=3842,"SystemVoltageIn"=19602,"SystemPowerIn"=0,"BatteryPower"=62918}
  |   "Amperage" = 18446744073709550652
  |   "IsCharging" = No
  | }
${CHILDREN}`;

/** What 27.2 does to an entry of the older layout: a guide in front of every line, then its children. */
function withGuides(entry: string): string {
  const [header, ...lines] = entry.trimEnd().split("\n");
  return [header, ...lines.map((line) => line.replace(/^ {2} /, "  |"))].join("\n") + "\n" + CHILDREN;
}

const DISCHARGING = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=34930787)\t87%; discharging; 4:32 remaining present: true
`;

const CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34930787)\t45%; charging; 1:23 remaining present: true
`;

const NO_ESTIMATE = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=34930787)\t61%; discharging; (no estimate) present: true
`;

const NOT_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34930787)\t79%; AC attached; not charging present: true
`;

test("a battery resting on the charger is neither filling nor draining", () => {
  const battery = parseBattery(CHARGED);
  assert.deepEqual(battery, { percent: 100, charging: false, charged: true, external: true, minutes: null, ...NO_WATTS });
});

test("discharging reports the power source and the time left", () => {
  const battery = parseBattery(DISCHARGING);
  assert.deepEqual(battery, { percent: 87, charging: false, charged: false, external: false, minutes: 272, ...NO_WATTS });
});

test("charging reports the time until full", () => {
  const battery = parseBattery(CHARGING);
  assert.deepEqual(battery, { percent: 45, charging: true, charged: false, external: true, minutes: 83, ...NO_WATTS });
});

test("no estimate is null rather than zero", () => {
  assert.equal(parseBattery(NO_ESTIMATE)?.minutes, null);
  assert.equal(parseBattery(NO_ESTIMATE)?.percent, 61);
});

test("AC attached but not charging reads as resting, not as draining", () => {
  const battery = parseBattery(NOT_CHARGING);
  assert.equal(battery?.charging, false);
  assert.equal(battery?.charged, true);
  assert.equal(battery?.external, true);
});

test("a machine without a battery parses as none", () => {
  assert.equal(parseBattery("Now drawing from 'AC Power'\n"), null);
  assert.equal(parseBattery(""), null);
});

test("a probe whose command fails reports no battery rather than throwing", async () => {
  const probe = createBatteryProbe(
    () => Promise.reject(new Error("pmset: not found")),
    async () => IOREG_CHARGING,
  );
  assert.equal(await probe.read(), null);
});

test("a probe passes the command's output through the parser", async () => {
  const probe = createBatteryProbe(
    () => Promise.resolve(DISCHARGING),
    async () => IOREG_DISCHARGING,
  );
  assert.equal((await probe.read())?.percent, 87);
});

test("on the charger: its rating, what comes in, and what reaches the battery", () => {
  assert.deepEqual(parsePower(IOREG_CHARGING), { adapterWatts: 96, inputWatts: 61.4, batteryWatts: 38 });
});

test("off the charger the adapter and the power in are null, and the battery drains", () => {
  // 11791 mV × −2256 mA: the amperage is −2256 printed as an unsigned 64-bit number.
  assert.deepEqual(parsePower(IOREG_DISCHARGING), { adapterWatts: null, inputWatts: null, batteryWatts: -26.6 });
});

test("a Mac without the telemetry still gets the rating and the battery's flow", () => {
  const older = IOREG_CHARGING.replace(/^.*"PowerTelemetryData".*\n/m, "");
  assert.deepEqual(parsePower(older), { adapterWatts: 96, inputWatts: null, batteryWatts: 38 });
});

test("a trickle that rounds to nothing is not shown as zero watts", () => {
  const trickle = IOREG_CHARGING.replace('"SystemPowerIn"=61432', '"SystemPowerIn"=40');
  assert.equal(parsePower(trickle).inputWatts, null);
});

test("ioreg output with none of the keys reads as no watts at all", () => {
  assert.deepEqual(parsePower(""), NO_WATTS);
});

test("macOS 27.2 draws the tree's guides before every line, and the watts read the same", () => {
  assert.deepEqual(parsePower(IOREG_27_2), { adapterWatts: 90, inputWatts: 13.3, batteryWatts: 0 });
});

test("the older layout, drawn with the guides, reads as it did without them", () => {
  for (const entry of [IOREG_CHARGING, IOREG_DISCHARGING]) {
    assert.deepEqual(parsePower(withGuides(entry)), parsePower(entry));
  }
});

test("the probe merges the watts into the battery", async () => {
  const probe = createBatteryProbe(
    async () => CHARGING,
    async () => IOREG_CHARGING,
  );
  assert.deepEqual(await probe.read(), { percent: 45, charging: true, charged: false, external: true, minutes: 83, adapterWatts: 96, inputWatts: 61.4, batteryWatts: 38 });
});

test("a failed ioreg leaves the battery as pmset reports it, without watts", async () => {
  const probe = createBatteryProbe(
    async () => CHARGING,
    () => Promise.reject(new Error("ioreg: not found")),
  );
  assert.deepEqual(await probe.read(), { percent: 45, charging: true, charged: false, external: true, minutes: 83, ...NO_WATTS });
});

test("the moment the charger goes in the power reads 0, and the current and voltage beside it stand in", () => {
  assert.deepEqual(parsePower(IOREG_27_2_PLUGGED_IN), { adapterWatts: 65, inputWatts: 75.3, batteryWatts: -10.9 });
});

test("a power field that reads a real figure is used as it is, whatever the current and voltage say", () => {
  const steady = IOREG_27_2_PLUGGED_IN.replace('"SystemPowerIn"=0', '"SystemPowerIn"=63240');
  assert.equal(parsePower(steady).inputWatts, 63.2);
});

test("no current and no voltage still means nothing is coming in", () => {
  const nothing = IOREG_27_2_PLUGGED_IN.replace('"SystemCurrentIn"=3842', '"SystemCurrentIn"=0');
  assert.equal(parsePower(nothing).inputWatts, null);
});
