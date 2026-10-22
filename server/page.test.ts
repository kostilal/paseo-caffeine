import { test } from "node:test";
import assert from "node:assert/strict";
import type { Battery } from "../shared/caffeine.shared.ts";
import { renderWakePage } from "./page.server.ts";

const AT = new Date("2026-09-21T07:05:00.000Z");
const charged: Battery = {
  percent: 99,
  charging: false,
  charged: true,
  external: true,
  minutes: null,
  adapterWatts: null,
  inputWatts: null,
  batteryWatts: null,
};

function page(overrides: Partial<Parameters<typeof renderWakePage>[0]> = {}): string {
  return renderWakePage({ host: "MacBook Pro", at: AT, mode: "on", active: true, battery: charged, ...overrides });
}

test("the page names the Mac and says it is awake", () => {
  const html = page();
  assert.match(html, /MacBook Pro/);
  assert.match(html, /awake/);
  assert.match(html, /woke at \d{2}:\d{2}/);
});

test("the power source is spelled out, not left to a glyph", () => {
  assert.match(page(), /99% · on the charger/);
  assert.match(page({ battery: { ...charged, external: false, charged: false } }), /99% · on battery/);
  assert.match(page({ battery: { ...charged, charging: true } }), /99% · charging/);
});

test("on the charger the page says how many watts are coming in", () => {
  assert.match(page({ battery: { ...charged, charging: true, inputWatts: 61.4 } }), /99% · charging · 61 W/);
  assert.doesNotMatch(page({ battery: { ...charged, external: false, charged: false, inputWatts: 61.4 } }), / W</);
});

test("a machine without a battery simply has no battery line", () => {
  const html = page({ battery: null });
  assert.doesNotMatch(html, /on the charger|on battery|charging/);
  // Not a bare /%/: the stylesheet is full of them.
  assert.doesNotMatch(html, /\d+% ·/);
  assert.match(html, /MacBook Pro/);
});

test("every mode says what it means rather than naming itself", () => {
  assert.match(page({ mode: "off" }), /macOS decides/);
  assert.match(page({ mode: "on" }), /until you say otherwise/);
  assert.match(page({ mode: "timer" }), /until the timer runs out/);
  assert.match(page({ mode: "auto" }), /while agents work/);
});

test("a hostname with markup in it cannot reach the page as markup", () => {
  // `scutil --set ComputerName` takes anything, and the name lands in a title and a
  // heading. It is the one value on this page that did not come from the plugin.
  const html = page({ host: '<img src=x onerror="alert(1)">' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("the page needs nothing from the network to render", () => {
  // The phone reading this may be on a VPN with no route anywhere else, a second after
  // the Mac woke. A stylesheet or a font from a CDN would be a page that never arrives.
  const html = page();
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script/);
});
