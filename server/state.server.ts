import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { mode } from "../shared/caffeine.shared.ts";
import { type Stored, defaultStored } from "./policy.ts";

/**
 * A fixed path, for the same reason the jobby plugin has one: a plugin cannot find its
 * own directory. Beside jobby's state because it is the same product family on the same
 * machine. Nothing in here is secret, so the default file mode is fine.
 */
export const STATE_FILE = join(homedir(), ".jobby-jobs", "caffeine.json");

// The switches default rather than being required, so a file written before they existed
// reads back as "the screen and a closed lid sleep as usual" instead of as malformed.
// Unknown keys are dropped on the way in, which is how a file left behind by an older
// version — one that still stored whether the sidebar entry was hidden — stops mattering.
const stored = z.object({
  mode,
  until: z.string().default(""),
  keepDisplay: z.boolean().default(false),
  lidClosed: z.boolean().default(false),
});

/** Absent, unreadable, malformed and unknown all mean the same thing: off. */
export async function readStored(path: string = STATE_FILE): Promise<Stored> {
  try {
    const parsed = stored.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : defaultStored();
  } catch {
    return defaultStored();
  }
}

/**
 * Temp file then rename, so a daemon killed mid-write leaves either the old file or the
 * new one, never half of each.
 */
export async function writeStored(value: Stored, path: string = STATE_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
