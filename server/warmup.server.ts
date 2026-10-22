import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { WarmupStatus } from "../shared/caffeine.shared.ts";

/**
 * Session warm-up: one tiny Haiku message per logged-in Claude config folder at a set hour, so
 * each login's 5-hour window starts before the working day and resets partway into it (warm up
 * at 06:00, start at 09:00, a fresh window at 11:00).
 *
 * It only happens while the Mac is awake; it does not wake it. A warm-up missed because the
 * Mac slept is caught up within `CATCH_UP_MS` of the hour and given up after that: a window
 * started late would reset late too, which is not what was asked for.
 */

export const WARMUP_FILE = join(homedir(), ".jobby-jobs", "caffeine-warmup.json");
/** How long after the hour a missed warm-up still runs. */
export const CATCH_UP_MS = 30 * 60_000;
const PING_TIMEOUT_MS = 90_000;

/** Variables that would make `claude` run as something other than the directory's login: an
 *  API key or another endpoint would bill the warm-up elsewhere, and a token or Keychain
 *  redirect would use another login. A key set in the directory's own settings is caught by
 *  `subscriptionLogin` instead. */
const OVERRIDES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
];

export interface WarmupResult {
  /** Who was warmed up: the login's email, or the directory when it has none. */
  login: string;
  ok: boolean;
  error: string;
}

export interface WarmupStored {
  enabled: boolean;
  /** Local time of day, "HH:MM". */
  time: string;
  /** The local day ("YYYY-MM-DD") of the last scheduled warm-up, so it runs once a day. */
  lastDay: string;
  /** RFC 3339 time of the last warm-up, scheduled or by hand, or "". */
  lastAt: string;
  results: WarmupResult[];
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const stored = z.object({
  enabled: z.boolean().default(false),
  time: z.string().regex(TIME).default("06:00"),
  lastDay: z.string().default(""),
  lastAt: z.string().default(""),
  results: z.array(z.object({ login: z.string(), ok: z.boolean(), error: z.string().default("") })).default([]),
});

export const defaultWarmup = (): WarmupStored => stored.parse({});

export async function readWarmup(path: string = WARMUP_FILE): Promise<WarmupStored> {
  try {
    const parsed = stored.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : defaultWarmup();
  } catch {
    return defaultWarmup();
  }
}

export async function writeWarmup(value: WarmupStored, path: string = WARMUP_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export function isValidTime(time: string): boolean {
  return TIME.test(time);
}

/** The local day of `at`, "YYYY-MM-DD". */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Today's warm-up instant in local time, in ms. */
export function todayAt(time: string, now: Date): number {
  const [hours, minutes] = time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours!, minutes!, 0, 0);
  return at.getTime();
}

/**
 * The scheduled warm-up that should run now, or null: on, within the catch-up window after
 * its hour, and not yet done. Yesterday's slot is looked at too, so a late-evening hour whose
 * catch-up window crosses midnight is not lost.
 */
export function dueSlot(value: WarmupStored, now: Date): Date | null {
  if (!value.enabled || !isValidTime(value.time)) return null;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  for (const day of [now, yesterday]) {
    const at = todayAt(value.time, day);
    if (now.getTime() >= at && now.getTime() < at + CATCH_UP_MS && value.lastDay !== localDay(new Date(at))) {
      return new Date(at);
    }
  }
  return null;
}

export function isDue(value: WarmupStored, now: Date): boolean {
  return dueSlot(value, now) !== null;
}

/** When the next scheduled warm-up is, RFC 3339, or "" when off. */
export function nextAt(value: WarmupStored, now: Date): string {
  if (!value.enabled || !isValidTime(value.time)) return "";
  const at = todayAt(value.time, now);
  const doneOrPast = value.lastDay === localDay(now) || now.getTime() >= at + CATCH_UP_MS;
  if (!doneOrPast) return new Date(at).toISOString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return new Date(todayAt(value.time, tomorrow)).toISOString();
}

/** What `claude auth status --json` says about a directory, the parts used here. */
export interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
}

/**
 * Whether a directory is logged in to a Claude subscription, which is the only kind of login
 * with a 5-hour window. An API key, Bedrock or Vertex login, from the environment or from the
 * directory's own settings, would only be billed for the warm-up.
 */
export function subscriptionLogin(status: AuthStatus): boolean {
  return status.loggedIn === true && status.authMethod === "claude.ai" && status.apiProvider === "firstParty";
}

/**
 * What gets a warm-up message: every logged-in config folder, one message each. Not one per
 * login: `claude auth status` names a folder's login from the cache in its `.claude.json`,
 * which Claude Code rewrites to whichever login last ran a chat there, so two folders can name
 * the same login while holding different ones. Merging by that name once sent a login's
 * warm-up through a folder that was really another login, and the login itself got none. A
 * message per folder reaches every token there is, whatever the cache says.
 */
export function warmupTargets(entries: ReadonlyArray<{ dir: string; status: AuthStatus }>): Login[] {
  return entries
    .filter(({ status }) => status.loggedIn === true)
    .map(({ dir, status }) => ({
      dir,
      key: dir,
      label: `${status.email || "?"} (${dir.slice(dir.lastIndexOf("/") + 1)})`,
      skip: subscriptionLogin(status) ? "" : "skipped: not a Claude subscription login",
    }));
}

export interface Login {
  dir: string;
  /** What makes two directories the same login: they share one allowance. */
  key: string;
  label: string;
  /** Why it is not warmed up (an API login), or "" to warm it up. */
  skip?: string;
}

export interface WarmupDeps {
  read(): Promise<WarmupStored>;
  write(value: WarmupStored): Promise<void>;
  /** Every logged-in Claude config folder on this Mac; see `warmupTargets`. */
  logins(): Promise<Login[]>;
  /** Sends one tiny message on the directory's login. */
  ping(dir: string): Promise<{ ok: boolean; error: string }>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface Warmup {
  start(): Promise<void>;
  tick(): Promise<void>;
  set(patch: { enabled?: boolean; time?: string }): Promise<void>;
  /** Warms up now, whatever the schedule. */
  runNow(): Promise<void>;
  status(): WarmupStatus;
}

export function createWarmup(deps: WarmupDeps): Warmup {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  let value = defaultWarmup();
  let running = false;

  async function save(next: WarmupStored): Promise<void> {
    value = next;
    await deps.write(value);
  }

  /** One warm-up at a time: a scheduled one and a press can arrive together. */
  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const at = now();
      const logins = await deps.logins();
      const results: WarmupResult[] = [];
      for (const login of logins) {
        if (login.skip) {
          results.push({ login: login.label, ok: false, error: login.skip });
          continue;
        }
        const outcome = await deps.ping(login.dir).catch((error: unknown) => ({ ok: false, error: String(error) }));
        results.push({ login: login.label, ok: outcome.ok, error: outcome.ok ? "" : outcome.error });
      }
      await save({ ...value, lastAt: at.toISOString(), results });
      log(`caffeine: warm-up: ${results.map((r) => `${r.login} ${r.ok ? "ok" : "failed"}`).join(", ") || "no logged-in accounts"}`);
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      value = await deps.read();
    },
    async tick() {
      const slot = dueSlot(value, now());
      if (slot === null) return;
      // Claimed before the slow part, and also when a warm-up by hand is already running (it
      // covers this one): either way the next tick does not start another.
      await save({ ...value, lastDay: localDay(slot) });
      await run();
    },
    async set(patch) {
      const next = { ...value };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.time !== undefined) {
        if (!isValidTime(patch.time)) throw new Error(`not a time of day: ${patch.time}`);
        next.time = patch.time;
      }
      await save(next);
    },
    runNow: () => run(),
    status: () => ({
      enabled: value.enabled,
      time: value.time,
      nextAt: nextAt(value, now()),
      lastAt: value.lastAt,
      results: value.results,
      running,
    }),
  };
}

function claudePaths(home: string): string[] {
  return [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".claude", "local", "claude"),
    join(home, ".npm-global", "bin", "claude"),
  ];
}

const isFile = (path: string) => stat(path).then((found) => found.isFile(), () => false);

async function findClaude(home: string): Promise<string> {
  for (const candidate of claudePaths(home)) if (await isFile(candidate)) return candidate;
  return "claude";
}

/** The environment for `claude` on one config directory; `~/.claude` is reached by leaving
 *  CLAUDE_CONFIG_DIR unset, which is how Claude Code names its default Keychain item. */
export function claudeEnv(dir: string, base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of OVERRIDES) delete env[name];
  if (dir.replace(/\/+$/, "") === join(home, ".claude")) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(file, [...args], { env, cwd: tmpdir(), timeout }, (failure, stdout, stderr) => {
      const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The real thing: `~/.claude` and every `~/.claude*` folder holding a `.claude.json`, asked
 *  whether they are logged in, each one warmed up on its own. */
export function systemWarmupDeps(log: (line: string) => void, home: string = homedir()): WarmupDeps {
  return {
    read: () => readWarmup(),
    write: (value) => writeWarmup(value),
    logins: async () => {
      const claude = await findClaude(home);
      const names = await readdir(home).catch(() => [] as string[]);
      const dirs = [join(home, ".claude")];
      for (const name of names.sort()) {
        if (!/^\.claude[-_.].+/.test(name)) continue;
        if (await isFile(join(home, name, ".claude.json"))) dirs.push(join(home, name));
      }
      const entries: Array<{ dir: string; status: AuthStatus }> = [];
      for (const dir of dirs) {
        const answer = await run(claude, ["auth", "status", "--json"], claudeEnv(dir, process.env, home), 20_000);
        try {
          entries.push({ dir, status: JSON.parse(answer.stdout) as AuthStatus });
        } catch {
          // Not a login we can read: skipped.
        }
      }
      return warmupTargets(entries);
    },
    ping: async (dir) => {
      const claude = await findClaude(home);
      // No tools, MCP servers, slash commands, user settings or hooks: the smallest message
      // that still runs on the directory's own subscription login (checked live).
      const args = [
        "-p",
        "Reply with the single word ok",
        "--model",
        "haiku",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "project",
        "--disable-slash-commands",
      ];
      const answer = await run(claude, args, claudeEnv(dir, process.env, home), PING_TIMEOUT_MS);
      if (answer.code === 0) return { ok: true, error: "" };
      const reason = (answer.stderr || answer.stdout).trim().split("\n").pop() ?? "";
      log(`caffeine: warm-up of ${dir} failed (exit ${answer.code}): ${reason}`);
      return { ok: false, error: reason || `exit ${answer.code}` };
    },
    log,
  };
}
