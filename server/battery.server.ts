import { execFile } from "node:child_process";
import type { Battery } from "../shared/caffeine.shared.ts";

/** Reading `pmset -g batt` costs a few milliseconds, so a tick can afford it. */
const PMSET = "/usr/bin/pmset";
const ARGS = ["-g", "batt"] as const;
/** The battery's own registry entry, where macOS keeps the watts pmset leaves out. */
const IOREG = "/usr/sbin/ioreg";
const IOREG_ARGS = ["-rw0", "-c", "AppleSmartBattery"] as const;

/**
 * `pmset -g batt` prints the power source on one line and, on a machine that has a
 * battery, one line per battery:
 *
 *     Now drawing from 'AC Power'
 *      -InternalBattery-0 (id=34930787)	100%; charged; 0:00 remaining present: true
 *
 * The state word is whatever pmset feels like — "charging", "discharging", "charged",
 * "AC attached; not charging", "finishing charge" — so it is matched by what it
 * contains rather than by equality. A desktop prints the first line and nothing else,
 * and gets null.
 */
export function parseBattery(text: string): Battery | null {
  const percentMatch = text.match(/(\d{1,3})%/);
  if (!percentMatch) return null;
  const percent = Math.min(100, Number(percentMatch[1]));

  const external = /drawing from ['"]AC Power['"]/i.test(text);
  const charging = /;\s*charging/i.test(text) || /finishing charge/i.test(text);
  // "charged" and "AC attached; not charging" both mean a full-ish battery that is
  // neither filling nor draining, and both should read as resting on the charger.
  const charged = /;\s*charged/i.test(text) || /not charging/i.test(text);

  // 0:00 accompanies "charged", where it means "not applicable" rather than "no time
  // left", and "(no estimate)" appears while pmset is still working it out.
  const timeMatch = text.match(/(\d+):(\d{2})\s+remaining/);
  let minutes: number | null = null;
  if (timeMatch) {
    const total = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
    if (total > 0) minutes = total;
  }

  return { percent, charging, charged, external, minutes, adapterWatts: null, inputWatts: null, batteryWatts: null };
}

export type Power = Pick<Battery, "adapterWatts" | "inputWatts" | "batteryWatts">;

const NO_POWER: Power = { adapterWatts: null, inputWatts: null, batteryWatts: null };

/**
 * A value from a `{"Key"=123,...}` dictionary that ioreg prints on one line. The whole
 * line is searched rather than up to the first `}`: a USB-C charger's dictionary carries
 * a nested `"UsbHvcMenu"=({...},{...})`, in whatever order ioreg likes.
 */
function nested(text: string, dictionary: string, key: string): number | null {
  const line = text.match(new RegExp(`^\\s*"${dictionary}" = (.*)$`, "m"))?.[1];
  const value = line?.match(new RegExp(`[{,]"${key}"=(\\d+)`))?.[1];
  return value === undefined ? null : Number(value);
}

/** A top-level `"Key" = 123` line. */
function plain(text: string, key: string): string | null {
  return text.match(new RegExp(`^\\s*"${key}" = (\\d+)\\s*$`, "m"))?.[1] ?? null;
}

function oneDecimal(watts: number): number {
  return Math.round(watts * 10) / 10;
}

/**
 * The watts in `ioreg -rw0 -c AppleSmartBattery`, which is where the menu-bar wattage
 * tools read them too:
 *
 *     "AdapterDetails" = {"Watts"=96,"Name"="96W USB-C Power Adapter",...}
 *     "PowerTelemetryData" = {"SystemPowerIn"=61234,...}      milliwatts from the charger
 *     "Voltage" = 12650                                         millivolts
 *     "Amperage" = 18446744073709549360                         milliamps, as an unsigned
 *                                                               64-bit number: negative = draining
 *
 * Off the charger the adapter's dictionary has no watts and the power in is zero, and both
 * read as null rather than as a charger rated at nothing. A Mac without the telemetry
 * dictionary (the older Intel ones) gets the adapter's rating and the battery flow only.
 */
export function parsePower(text: string): Power {
  const external = /^\s*"ExternalConnected" = Yes\s*$/m.test(text);

  const rated = nested(text, "AdapterDetails", "Watts");
  const adapterWatts = external && rated !== null && rated > 0 ? rated : null;

  const powerIn = nested(text, "PowerTelemetryData", "SystemPowerIn");
  const watts = powerIn === null ? 0 : oneDecimal(powerIn / 1000);
  const inputWatts = external && watts > 0 ? watts : null;

  const volts = plain(text, "Voltage");
  const amps = plain(text, "Amperage");
  let batteryWatts: number | null = null;
  if (volts !== null && amps !== null) {
    const milliamps = Number(BigInt.asIntN(64, BigInt(amps)));
    batteryWatts = oneDecimal((Number(volts) * milliamps) / 1_000_000);
  }

  return { adapterWatts, inputWatts, batteryWatts };
}

export interface BatteryProbe {
  /** The battery now, or null on a machine without one or when pmset will not answer. */
  read(): Promise<Battery | null>;
}

type Runner = () => Promise<string>;

function runner(file: string, args: readonly string[]): Runner {
  return () =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout: 5_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
}

export function createBatteryProbe(
  run: Runner = runner(PMSET, ARGS),
  runIoreg: Runner = runner(IOREG, IOREG_ARGS),
): BatteryProbe {
  return {
    async read() {
      const [batt, ioreg] = await Promise.allSettled([run(), runIoreg()]);
      // A battery that cannot be read is simply not shown; it has no say in whether
      // the Mac stays awake, so there is nothing to resolve towards.
      if (batt.status === "rejected") return null;
      const battery = parseBattery(batt.value);
      if (!battery) return null;
      // The watts are an extra: without them the battery still shows as it always did.
      const power = ioreg.status === "fulfilled" ? parsePower(ioreg.value) : NO_POWER;
      return { ...battery, ...power };
    },
  };
}
