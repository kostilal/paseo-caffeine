import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStored, writeStored } from "./state.server.ts";

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "caffeine-")), "nested", "caffeine.json");
}

test("a missing file reads as off", async () => {
  assert.deepEqual(await readStored(await scratch()), { mode: "off", until: "", keepDisplay: false, lidClosed: false });
});

test("a malformed file reads as off", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "caffeine-")), "caffeine.json");
  await writeFile(file, "{ not json", "utf8");
  assert.deepEqual(await readStored(file), { mode: "off", until: "", keepDisplay: false, lidClosed: false });
});

test("a file with an unknown mode reads as off", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "caffeine-")), "caffeine.json");
  await writeFile(file, JSON.stringify({ mode: "sideways", until: "" }), "utf8");
  assert.deepEqual(await readStored(file), { mode: "off", until: "", keepDisplay: false, lidClosed: false });
});

test("what is written is read back, creating directories on the way", async () => {
  const file = await scratch();
  await writeStored({ mode: "timer", until: "2026-09-09T21:00:00.000Z", keepDisplay: false, lidClosed: false }, file);
  assert.deepEqual(await readStored(file), { mode: "timer", until: "2026-09-09T21:00:00.000Z", keepDisplay: false, lidClosed: false });
  assert.match(await readFile(file, "utf8"), /"mode": "timer"/);
});

test("writing leaves no temp file behind", async () => {
  const file = await scratch();
  await writeStored({ mode: "on", until: "", keepDisplay: false, lidClosed: false }, file);
  const siblings = await readdir(join(file, ".."));
  assert.deepEqual(siblings, ["caffeine.json"]);
});

test("a file written before the lid switch existed reads as switched off", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "caffeine-")), "caffeine.json");
  await writeFile(file, JSON.stringify({ mode: "on", until: "" }), "utf8");
  assert.deepEqual(await readStored(file), { mode: "on", until: "", keepDisplay: false, lidClosed: false });
});

test("the lid switch survives a write and a read", async () => {
  const file = await scratch();
  await writeStored({ mode: "auto", until: "", keepDisplay: false, lidClosed: true }, file);
  assert.deepEqual(await readStored(file), { mode: "auto", until: "", keepDisplay: false, lidClosed: true });
});
