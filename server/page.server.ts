import type { Battery, Mode } from "../shared/caffeine.shared.ts";

export interface PageInput {
  host: string;
  /** When the knock arrived, which on a wake is within a second of the Mac coming back. */
  at: Date;
  mode: Mode;
  active: boolean;
  battery: Battery | null;
}

const MODE_WORDS: Record<Mode, string> = {
  off: "macOS decides when it sleeps",
  on: "held awake until you say otherwise",
  timer: "held awake until the timer runs out",
  auto: "held awake while agents work",
};

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function batteryLine(battery: Battery | null): string {
  if (!battery) return "";
  const source = battery.external ? "on the charger" : "on battery";
  const watts = battery.external && battery.inputWatts !== null ? ` · ${Math.round(battery.inputWatts)} W` : "";
  if (battery.charging) return `${battery.percent}% · charging${watts}`;
  return `${battery.percent}% · ${source}${watts}`;
}

/**
 * What the phone sees after the knock that woke the Mac.
 *
 * Everything is inline — no fonts, no scripts, no second request. Whoever is reading
 * this reached a machine that was asleep a second ago, quite possibly over a VPN from
 * a train, and a page that waits on a CDN would be a page that never arrives. The whole
 * thing is one response and renders before the Mac has finished stretching.
 *
 * It says the same three things the surface does — awake, on what power, under which
 * mode — because the question behind pressing the link is always "did it come back".
 */
export function renderWakePage(input: PageInput): string {
  const time = input.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const battery = batteryLine(input.battery);
  const accent = input.active ? "#4ade80" : "#94a3b8";

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(input.host)} is awake</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0f14; color: #e5e7eb; padding: 24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  }
  .card {
    width: 100%; max-width: 420px; padding: 28px;
    border: 1px solid #1f2937; border-radius: 20px; background: #111827;
    text-align: center;
  }
  .dot {
    width: 12px; height: 12px; border-radius: 50%; display: inline-block;
    background: ${accent}; margin-right: 8px; vertical-align: middle;
    box-shadow: 0 0 0 6px ${accent}22;
  }
  .state { font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: ${accent} }
  h1 { margin: 14px 0 4px; font-size: 26px; font-weight: 650; letter-spacing: -0.4px }
  .time { font-size: 15px; color: #9ca3af }
  .facts { margin-top: 22px; padding-top: 18px; border-top: 1px solid #1f2937; display: grid; gap: 6px }
  .facts div { font-size: 14px; color: #9ca3af }
  .caffeine { color: #e5e7eb }
</style>
<div class="card">
  <div class="state"><span class="dot"></span>awake</div>
  <h1>${escape(input.host)}</h1>
  <div class="time">woke at ${escape(time)}</div>
  <div class="facts">
    ${battery ? `<div>${escape(battery)}</div>` : ""}
    <div class="caffeine">Caffeine: ${escape(MODE_WORDS[input.mode])}</div>
  </div>
</div>
`;
}
