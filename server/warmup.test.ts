import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATCH_UP_MS,
  type Login,
  type WarmupStored,
  claudeEnv,
  createWarmup,
  defaultWarmup,
  dueSlot,
  isDue,
  localDay,
  nextAt,
  subscriptionLogin,
  warmupTargets,
} from "./warmup.server.ts";

// Local times, as the schedule is: 20 Oct 2026 in whatever zone the tests run in.
const at = (hours: number, minutes = 0, day = 20) => new Date(2026, 9, day, hours, minutes, 0, 0);
const on = (overrides: Partial<WarmupStored> = {}): WarmupStored => ({ ...defaultWarmup(), enabled: true, time: "06:00", ...overrides });

test("due from the hour until the catch-up window closes, once a day, and never while off", () => {
  assert.equal(isDue(on(), at(5, 59)), false, "not before the hour");
  assert.equal(isDue(on(), at(6, 0)), true);
  assert.equal(isDue(on(), at(6, 29)), true, "caught up after a short sleep");
  assert.equal(isDue(on(), new Date(at(6).getTime() + CATCH_UP_MS)), false, "too late: the window would reset late");
  assert.equal(isDue(on({ lastDay: localDay(at(6)) }), at(6, 5)), false, "already done today");
  assert.equal(isDue(on({ lastDay: localDay(at(6, 0, 19)) }), at(6, 5)), true, "yesterday's run does not count");
  assert.equal(isDue(on({ enabled: false }), at(6, 5)), false);
  assert.equal(isDue(on({ time: "25:00" }), at(6, 5)), false, "a broken time never fires");
});

test("the next warm-up is today's until it is done or missed, then tomorrow's", () => {
  assert.equal(nextAt(on(), at(5)), at(6).toISOString());
  assert.equal(nextAt(on({ lastDay: localDay(at(6)) }), at(6, 10)), at(6, 0, 21).toISOString());
  assert.equal(nextAt(on(), at(7)), at(6, 0, 21).toISOString());
  assert.equal(nextAt(on({ enabled: false }), at(5)), "");
});

function fake(options: { logins?: Login[]; fails?: string[]; stored?: WarmupStored; clock?: Date } = {}) {
  let value = options.stored ?? on();
  let clock = options.clock ?? at(6, 1);
  const pings: string[] = [];
  const warmup = createWarmup({
    read: async () => value,
    write: async (next) => void (value = next),
    logins: async () => options.logins ?? [{ dir: "/h/.claude", key: "a", label: "a@x" }, { dir: "/h/.claude-work", key: "b", label: "b@y" }],
    ping: async (dir) => {
      pings.push(dir);
      await new Promise((resolve) => setImmediate(resolve));
      return options.fails?.includes(dir) ? { ok: false, error: "rate limited" } : { ok: true, error: "" };
    },
    now: () => clock,
  });
  return { warmup, pings, stored: () => value, move: (to: Date) => void (clock = to) };
}

test("at the hour every login is warmed up once, and the day is marked done", async () => {
  const f = fake();
  await f.warmup.start();
  await f.warmup.tick();
  await f.warmup.tick();
  assert.deepEqual(f.pings, ["/h/.claude", "/h/.claude-work"]);
  assert.equal(f.stored().lastDay, localDay(at(6, 1)));
  assert.equal(f.stored().lastAt, at(6, 1).toISOString());
  assert.deepEqual(f.stored().results.map((r) => r.ok), [true, true]);
});

test("ticks that arrive while a warm-up runs do not start a second one", async () => {
  const f = fake();
  await f.warmup.start();
  await Promise.all([f.warmup.tick(), f.warmup.tick(), f.warmup.runNow()]);
  assert.equal(f.pings.length, 2);
});

test("a login that fails is recorded with its reason; the others still run", async () => {
  const f = fake({ fails: ["/h/.claude"] });
  await f.warmup.start();
  await f.warmup.tick();
  assert.deepEqual(f.stored().results, [
    { login: "a@x", ok: false, error: "rate limited" },
    { login: "b@y", ok: true, error: "" },
  ]);
  assert.equal(f.warmup.status().running, false);
});

test("a tick that arrives during a warm-up by hand still claims the day", async () => {
  const f = fake();
  await f.warmup.start();
  const byHand = f.warmup.runNow();
  await f.warmup.tick();
  await byHand;
  await f.warmup.tick();
  assert.equal(f.pings.length, 2, "one warm-up, not two in a minute");
  assert.equal(f.stored().lastDay, localDay(at(6, 1)));
});

test("a late-evening hour is still caught up just after midnight, and counted for its own day", () => {
  const late = on({ time: "23:50" });
  const slot = dueSlot(late, at(0, 10, 21));
  assert.equal(slot?.getTime(), at(23, 50, 20).getTime());
  assert.equal(isDue({ ...late, lastDay: localDay(at(23, 50, 20)) }, at(0, 10, 21)), false);
  assert.equal(isDue(late, at(0, 30, 21)), false, "the window closed at 00:20");
});

test("only a Claude subscription login is warmed up; an API, Bedrock or Vertex login is not", () => {
  const sub = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" };
  assert.equal(subscriptionLogin(sub), true);
  assert.equal(subscriptionLogin({ ...sub, authMethod: "api_key" }), false);
  assert.equal(subscriptionLogin({ ...sub, apiProvider: "bedrock" }), false);
  assert.equal(subscriptionLogin({ ...sub, loggedIn: false }), false);
  assert.equal(subscriptionLogin({ loggedIn: true }), false, "unknown is not a subscription");
});

test("a skipped login is reported, not pinged", async () => {
  const f = fake({ logins: [{ dir: "/h/.claude-api", key: "k", label: "api@x", skip: "skipped: not a Claude subscription login" }] });
  await f.warmup.start();
  await f.warmup.runNow();
  assert.deepEqual(f.pings, []);
  assert.deepEqual(f.stored().results, [{ login: "api@x", ok: false, error: "skipped: not a Claude subscription login" }]);
});

test("warming up by hand does not use up the day's scheduled run", async () => {
  const f = fake({ clock: at(5) });
  await f.warmup.start();
  await f.warmup.runNow();
  assert.equal(f.stored().lastDay, "");
  f.move(at(6, 2));
  await f.warmup.tick();
  assert.equal(f.pings.length, 4);
});

test("the hour is checked before it is stored", async () => {
  const f = fake();
  await f.warmup.start();
  await assert.rejects(f.warmup.set({ time: "6am" }));
  await f.warmup.set({ time: "05:30", enabled: false });
  assert.equal(f.stored().time, "05:30");
  assert.equal(f.stored().enabled, false);
});

test("claude runs on the directory's own login, never on an inherited key or token", () => {
  const base = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "k",
    ANTHROPIC_AUTH_TOKEN: "t",
    ANTHROPIC_BASE_URL: "https://proxy",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "o",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "/x",
    CLAUDE_CONFIG_DIR: "/elsewhere",
  };
  const work = claudeEnv("/home/me/.claude-work", base, "/home/me");
  assert.deepEqual(work, { PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/me/.claude-work" });
  const own = claudeEnv("/home/me/.claude/", base, "/home/me");
  assert.deepEqual(own, { PATH: "/bin" }, "the default directory is reached by leaving the variable unset");
});

test("every logged-in folder is warmed up, even when two name the same login", () => {
  // Seen live: .claude-laco-data's cache named the same login as .claude-work while holding
  // another; merging by name warmed laco-data and left .claude-work's login cold.
  const sub = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" };
  const targets = warmupTargets([
    { dir: "/h/.claude", status: { ...sub, email: "a@x" } },
    { dir: "/h/.claude-laco-data", status: { ...sub, email: "b@y", orgId: "o" } },
    { dir: "/h/.claude-work", status: { ...sub, email: "b@y", orgId: "o" } },
    { dir: "/h/.claude-gone", status: { loggedIn: false } },
    { dir: "/h/.claude-api", status: { loggedIn: true, authMethod: "api_key", email: "c@z" } },
  ]);
  assert.deepEqual(
    targets.map((t) => [t.dir, t.label, t.skip ?? ""]),
    [
      ["/h/.claude", "a@x (.claude)", ""],
      ["/h/.claude-laco-data", "b@y (.claude-laco-data)", ""],
      ["/h/.claude-work", "b@y (.claude-work)", ""],
      ["/h/.claude-api", "c@z (.claude-api)", "skipped: not a Claude subscription login"],
    ],
  );
});
