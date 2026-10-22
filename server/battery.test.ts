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
