import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heatShell } from "./lid.server.ts";

/**
 * The LaunchAgent guard's heat check, run for real by /bin/sh against stand-in commands: a
 * pmset that only writes down what it was asked (and moves a fake clock on "sleepnow" when
 * the test says the sleep works), a sudo that runs it, and notifyutil, ioreg and ps that
 * answer from files. Nothing here can sleep the Mac or touch its settings.
 */

interface Machine {
  pressure?: string;
  battery?: string;
  lid?: "Yes" | "No";
  fanPct?: string;
  sleepWorks?: boolean;
  conf?: string;
  latch?: string;
  dryRun?: boolean;
  lockHeld?: boolean;
  assertions?: string;
  psArgs?: string;
}

function fakeMac(machine: Machine = {}) {
  const dir = mkdtempSync(join(tmpdir(), "caffeine-guard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const files = {
    conf: join(dir, "thermal.conf"),
    latch: join(dir, "latch"),
    lock: join(dir, "lock"),
    dryRun: join(dir, "dryrun"),
    keeperPid: join(dir, "keeper.pid"),
    handover: join(dir, "handover"),
    log: join(dir, "guard.log"),
  };
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nT="$CAFFEINE_TEST_DIR"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    "pmset",
    [
      'echo "pmset $*" >> "$T/calls"',
      'case "$1" in',
      '  -g) if [ "$2" = assertions ]; then cat "$T/assertions" 2>/dev/null; else printf " SleepDisabled\\t\\t%s\\n" "$(cat "$T/sleepdisabled")"; fi ;;',
      '  -a) if [ "$2" = disablesleep ]; then echo "$3" > "$T/sleepdisabled"; fi ;;',
      '  sleepnow) if [ -f "$T/sleep-works" ]; then echo $(( $(cat "$T/clock") + 600 )) > "$T/clock"; fi ;;',
      "esac",
    ].join("\n"),
  );
  script("sudo", 'echo "sudo $*" >> "$T/calls"\nshift\nexec "$@"');
  script("notifyutil", '[ -s "$T/pressure" ] && echo "com.apple.system.thermalpressurelevel $(cat "$T/pressure")"\nexit 0');
  script(
    "ioreg",
    [
      'case "$*" in',
      '  *AppleSmartBattery*) [ -s "$T/battery" ] && printf \'    "Temperature" = %s\\n\' "$(cat "$T/battery")" ;;',
      '  *AppleClamshellState*) printf \'  |   "AppleClamshellState" = %s\\n\' "$(cat "$T/lid")" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  script("ps", 'cat "$T/ps-args"');
  script("clock", 'cat "$T/clock"');
  script("helper", 'cat "$T/fanpct"');

  write("calls", "");
  write("sleepdisabled", "1\n");
  write("clock", "1000000\n");
  write("pressure", machine.pressure ?? "0");
  write("battery", machine.battery ?? "3100");
  write("lid", machine.lid ?? "Yes");
  write("fanpct", machine.fanPct ?? "0");
  write("assertions", machine.assertions ?? "");
  write("ps-args", machine.psArgs ?? "");
  if (machine.sleepWorks ?? true) write("sleep-works", "");
  writeFileSync(files.conf, machine.conf ?? `PRESSURE_LEVEL=2\nPRESSURE_DELAY=60\nFAN_PCT=85\nFAN_DELAY=60\nHELPER=${join(bin, "helper")}\n`);
  if (machine.latch) writeFileSync(files.latch, machine.latch);
  if (machine.dryRun) writeFileSync(files.dryRun, "");
  if (machine.lockHeld) mkdirSync(files.lock);

  const env = {
    ...process.env,
    CAFFEINE_TEST_DIR: dir,
    CAFFEINE_PMSET: join(bin, "pmset"),
    CAFFEINE_SUDO: join(bin, "sudo"),
    CAFFEINE_NOTIFYUTIL: join(bin, "notifyutil"),
    CAFFEINE_IOREG: join(bin, "ioreg"),
    CAFFEINE_PS: join(bin, "ps"),
    CAFFEINE_CLOCK: join(bin, "clock"),
    CAFFEINE_VERIFY_S: "0",
    CAFFEINE_SETTLE_S: "0",
  };
  /** Runs the guard's functions followed by `steps` (sh), with helpers to move time and readings. */
  const run = (steps: string) =>
    execFileSync(
      "/bin/sh",
      [
        "-c",
        [
          heatShell(files),
          'advance() { echo $(( $(cat "$CAFFEINE_TEST_DIR/clock") + $1 )) > "$CAFFEINE_TEST_DIR/clock"; }',
          'set_reading() { printf "%s" "$2" > "$CAFFEINE_TEST_DIR/$1"; }',
          steps,
        ].join("\n"),
      ],
      { env, encoding: "utf8" },
    );
  const calls = () => readFileSync(join(dir, "calls"), "utf8").split("\n").filter((line) => line !== "");
  const latch = () => (existsSync(files.latch) ? readFileSync(files.latch, "utf8") : null);
  const sleepDisabled = () => readFileSync(join(dir, "sleepdisabled"), "utf8").trim();
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, files, run, calls, latch, sleepDisabled, write, cleanup };
}

/** Ticks every 15 s, `count` times, from the guard's point of view. */
const ticks = (count: number) => Array.from({ length: count }, () => "heat_tick; advance 15").join("\n");
const sleepnows = (calls: string[]) => calls.filter((call) => call === "pmset sleepnow").length;

test("a dry run writes what it would have done and runs nothing that changes the Mac", () => {
  const mac = fakeMac({ pressure: "3", dryRun: true });
  try {
    const out = mac.run(ticks(3));
    assert.match(out, /dry run: would put the Mac to sleep \(trapping: Trapping\)/);
    assert.match(mac.latch() ?? "", /^dry=1$/m);
    assert.deepEqual(mac.calls().filter((call) => !call.startsWith("pmset -g")), [], "no sudo, no sleepnow");
    assert.equal(mac.sleepDisabled(), "1", "lid mode left alone");
  } finally {
    mac.cleanup();
  }
});

test("trapping: sleep switched back on and confirmed, then sleepnow, and the latch says it slept", () => {
  const mac = fakeMac({ pressure: "3" });
  try {
    mac.run("heat_tick");
    const calls = mac.calls();
    const allow = calls.indexOf("sudo -n " + join(mac.dir, "bin", "pmset") + " -a disablesleep 0");
    assert.ok(allow >= 0, "sudo -n pmset -a disablesleep 0");
    assert.ok(allow < calls.indexOf("pmset sleepnow"), "sleep allowed before sleepnow");
    assert.equal(mac.sleepDisabled(), "0");
    assert.match(mac.latch() ?? "", /^reason=trapping$/m);
    assert.match(mac.latch() ?? "", /^dry=0$/m);
    assert.match(mac.latch() ?? "", /^slept=1$/m);
    assert.ok(!existsSync(mac.files.lock), "the lock is given back");
  } finally {
    mac.cleanup();
  }
});

test("heavy waits its 60 s; moderate waits its own delay, and heavy under it at most 60 s", () => {
  const heavy = fakeMac({ pressure: "2" });
  try {
    heavy.run(ticks(4));
    assert.equal(sleepnows(heavy.calls()), 0, "45 s is not enough");
    heavy.run("S2=$(( $(now) - 60 )); heat_tick");
    assert.equal(sleepnows(heavy.calls()), 1);
    assert.match(heavy.latch() ?? "", /^detail=Heavy 60 s$/m);
  } finally {
    heavy.cleanup();
  }
  const moderate = fakeMac({ pressure: "1", conf: "PRESSURE_LEVEL=1\nPRESSURE_DELAY=120\nFAN_PCT=85\nFAN_DELAY=60\n" });
  try {
    moderate.run(ticks(8));
    assert.equal(sleepnows(moderate.calls()), 0, "0 … 105 s of moderate");
  } finally {
    moderate.cleanup();
  }
  const moderateDue = fakeMac({ pressure: "1", conf: "PRESSURE_LEVEL=1\nPRESSURE_DELAY=120\nFAN_PCT=85\nFAN_DELAY=60\n" });
  try {
    moderateDue.run(`${ticks(8)}\nheat_tick`);
    assert.equal(sleepnows(moderateDue.calls()), 1, "the reading at 120 s");
    assert.match(moderateDue.latch() ?? "", /^detail=Moderate 120 s$/m);
  } finally {
    moderateDue.cleanup();
  }
  const capped = fakeMac({ pressure: "2", conf: "PRESSURE_LEVEL=1\nPRESSURE_DELAY=600\n" });
  try {
    capped.run(`${ticks(4)}\nheat_tick`);
    assert.equal(sleepnows(capped.calls()), 1, "heavy at 60 s even with moderate at 600 s");
  } finally {
    capped.cleanup();
  }
});

test("the battery trips on its second reading at 45 °C, not on one", () => {
  const mac = fakeMac({ battery: "4510" });
  try {
    mac.run("heat_tick; advance 15");
    assert.equal(sleepnows(mac.calls()), 0);
    mac.run("BH=1; heat_tick");
    assert.equal(sleepnows(mac.calls()), 1);
    assert.match(mac.latch() ?? "", /^reason=battery$/m);
    assert.match(mac.latch() ?? "", /^detail=45\.1 °C$/m);
  } finally {
    mac.cleanup();
  }
});

test("blind for 90 s with the lid closed sleeps; with the lid open it does not", () => {
  const closed = fakeMac({ pressure: "", battery: "" });
  try {
    closed.run(ticks(6));
    assert.equal(sleepnows(closed.calls()), 0, "0 … 75 s");
  } finally {
    closed.cleanup();
  }
  const closedDue = fakeMac({ pressure: "", battery: "" });
  try {
    closedDue.run(`${ticks(6)}\nheat_tick`);
    assert.equal(sleepnows(closedDue.calls()), 1, "the reading at 90 s");
    assert.match(closedDue.latch() ?? "", /^reason=blind$/m);
  } finally {
    closedDue.cleanup();
  }
  const open = fakeMac({ pressure: "", battery: "", lid: "No" });
  try {
    open.run(ticks(20));
    assert.equal(sleepnows(open.calls()), 0);
  } finally {
    open.cleanup();
  }
});

test("the fans trip with the lid closed after their delay; a dip within 10 points keeps the run", () => {
  const mac = fakeMac({ fanPct: "87" });
  try {
    mac.run([ticks(2), 'set_reading fanpct 77', ticks(2), 'set_reading fanpct 87', "heat_tick"].join("\n"));
    assert.equal(sleepnows(mac.calls()), 1);
    assert.match(mac.latch() ?? "", /^reason=fans$/m);
  } finally {
    mac.cleanup();
  }
  const reset = fakeMac({ fanPct: "87" });
  try {
    reset.run([ticks(2), "set_reading fanpct 70", "heat_tick", "advance 15", "set_reading fanpct 87", ticks(3)].join("\n"));
    assert.equal(sleepnows(reset.calls()), 0, "a drop under 75 % starts over");
  } finally {
    reset.cleanup();
  }
  const open = fakeMac({ fanPct: "95", lid: "No" });
  try {
    open.run(ticks(10));
    assert.equal(sleepnows(open.calls()), 0, "not with the lid open");
  } finally {
    open.cleanup();
  }
});

test("a sleep that never takes is tried three times and recorded with who holds it", () => {
  const mac = fakeMac({
    pressure: "3",
    sleepWorks: false,
    assertions: '   pid 512(Amphetamine): [0x0] 00:10:00 PreventSystemSleep named: "session"\n   pid 7(coreaudiod): [0x1] 00:01:00 PreventUserIdleSystemSleep named: "audio"\n',
  });
  try {
    mac.run("heat_tick");
    assert.equal(sleepnows(mac.calls()), 3);
    assert.match(mac.latch() ?? "", /^slept=0$/m);
    assert.match(mac.latch() ?? "", /^holders=Amphetamine $/m);
  } finally {
    mac.cleanup();
  }
});

test("only Caffeine's own caffeinate is stopped: the pid it wrote, tied to the plugin's pid", async () => {
  const stray = spawn("/bin/sleep", ["300"]);
  const ours = spawn("/bin/sleep", ["300"]);
  const exited = (child: ReturnType<typeof spawn>) => new Promise((resolve) => child.once("exit", resolve));
  const mac = fakeMac({ pressure: "3", psArgs: "/usr/bin/caffeinate -i -s -w 4242" });
  try {
    writeFileSync(mac.files.keeperPid, `${ours.pid} 4242\n`);
    const gone = exited(ours);
    mac.run("heat_tick");
    await gone;
    assert.equal(ours.exitCode ?? ours.signalCode, "SIGTERM");
    // A pid file naming a process that is not caffeinate -w <plugin> is left alone.
    const other = fakeMac({ pressure: "3", psArgs: "/usr/bin/caffeinate -i -s -w 9999" });
    try {
      writeFileSync(other.files.keeperPid, `${stray.pid} 4242\n`);
      other.run("heat_tick");
      assert.equal(stray.exitCode, null);
      assert.equal(stray.signalCode, null);
    } finally {
      other.cleanup();
    }
  } finally {
    stray.kill();
    ours.kill();
    mac.cleanup();
  }
});

test("while a real latch holds with the lid closed, a woken Mac goes back down at most once a minute", () => {
  const latch = "at=999000\nreason=battery\ndetail=45.2 °C\ndry=0\nby=plugin\nslept=1\n";
  // The fake sleepnow does not move the clock here: each look is a wake that lasted on.
  const mac = fakeMac({ latch, pressure: "3", sleepWorks: false });
  try {
    mac.run("heat_tick; advance 30; heat_tick; advance 31; heat_tick");
    assert.equal(sleepnows(mac.calls()), 2, "at 0 s and at 61 s, not at 30 s");
    assert.ok(!mac.latch()?.includes("reason=trapping"), "a latch is not overwritten by a new trip");
  } finally {
    mac.cleanup();
  }
  const open = fakeMac({ latch, lid: "No" });
  try {
    open.run(ticks(5));
    assert.equal(sleepnows(open.calls()), 0, "the lid open: somebody is there");
  } finally {
    open.cleanup();
  }
  const dry = fakeMac({ latch, dryRun: true });
  try {
    dry.run(ticks(5));
    assert.equal(sleepnows(dry.calls()), 0, "the dry-run switch outranks a latch");
  } finally {
    dry.cleanup();
  }
  const dryLatch = fakeMac({ latch: latch.replace("dry=0", "dry=1") });
  try {
    dryLatch.run(ticks(5));
    assert.equal(sleepnows(dryLatch.calls()), 0, "a dry-run record blocks nothing");
  } finally {
    dryLatch.cleanup();
  }
});

test("a latch that finds sleep switched off again switches it back on", () => {
  const mac = fakeMac({ latch: "at=999000\nreason=battery\ndry=0\nby=plugin\n", lid: "No" });
  try {
    mac.run("heat_tick");
    assert.equal(mac.sleepDisabled(), "0");
  } finally {
    mac.cleanup();
  }
});

test("when the plugin holds the lock, the guard stands back", () => {
  const mac = fakeMac({ pressure: "3", lockHeld: true });
  try {
    const out = mac.run("heat_tick");
    assert.match(out, /the plugin is already on it/);
    assert.equal(sleepnows(mac.calls()), 0);
  } finally {
    mac.cleanup();
  }
});

test("TERM switches sleep back on, unless a new guard is taking over", () => {
  const mac = fakeMac();
  try {
    mac.run("kill -TERM $$; nap 1");
    assert.equal(mac.sleepDisabled(), "0", "a logout: sleep back on");
    mac.write("sleepdisabled", "1\n");
    writeFileSync(mac.files.handover, "x");
    mac.run("kill -TERM $$; nap 1");
    assert.equal(mac.sleepDisabled(), "1", "a handover: lid mode goes on");
    const stale = Date.now() / 1000 - 600;
    utimesSync(mac.files.handover, stale, stale);
    mac.run("kill -TERM $$; nap 1");
    assert.equal(mac.sleepDisabled(), "0", "a handover file ten minutes old is not one");
  } finally {
    mac.cleanup();
  }
});

test("garbage in the settings file falls back to the defaults, and a relative helper path is ignored", () => {
  const mac = fakeMac({ pressure: "2", fanPct: "99", conf: "PRESSURE_DELAY=abc\nPRESSURE_LEVEL=7\nFAN_PCT=500\nFAN_DELAY=-1\nHELPER=bin/helper\n" });
  try {
    mac.run(`${ticks(4)}\nheat_tick`);
    assert.equal(sleepnows(mac.calls()), 1, "heavy at the default 60 s");
    assert.match(mac.latch() ?? "", /^reason=pressure$/m, "the fans were never read: no usable helper");
  } finally {
    mac.cleanup();
  }
});

test("on this Mac, read-only: the guard reads a real pressure level and a real battery temperature", () => {
  const out = execFileSync("/bin/sh", ["-c", `${heatShell()}\necho "p=$(pressure) b=$(battery)"; if lid_closed; then echo lid=closed; else echo lid=open; fi`], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  const match = /p=(\d) b=(\d+)/.exec(out);
  assert.ok(match, `readings: ${out}`);
  assert.ok(Number(match[1]) <= 4);
  assert.ok(Number(match[2]) > 1000 && Number(match[2]) < 9000, "hundredths of a degree");
});

test("a lock left by a crash (over five minutes old) is taken over; a fresh one is respected", () => {
  const mac = fakeMac({ pressure: "3", lockHeld: true });
  try {
    const old = Date.now() / 1000 - 600;
    utimesSync(mac.files.lock, old, old);
    const out = mac.run("heat_tick");
    assert.match(out, /took over a lock left \d+ s ago/);
    assert.equal(sleepnows(mac.calls()), 1);
    assert.ok(!existsSync(mac.files.lock), "and given back");
  } finally {
    mac.cleanup();
  }
});
