import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Battery, LidSetup, LidStatus, LidStopped } from "../shared/caffeine.shared.ts";

/**
 * Lid mode: the Mac keeps running with the lid closed and no display attached, for a while.
 *
 * `caffeinate` cannot do this — a closed lid sleeps a MacBook whatever holds it — so this
 * flips the system-wide `pmset disablesleep` switch, which needs root. A sudoers rule set up
 * once allows exactly the two commands below and nothing else, so the plugin can flip it
 * from anywhere, the phone included, and flip it back on its own.
 *
 * A Mac that never sleeps in a closed bag heats up and drains, so getting back to normal is
 * the part built to hold: the plugin's own deadline, a guard that restores sleep at the
 * deadline even if Paseo is gone by then (a LaunchAgent, so it also runs again after a reboot,
 * at login), a low-battery cut-off, and a check on every start. With no end there is no
 * deadline to wait for, so that guard waits for Caffeine instead: once the plugin has not
 * beaten for a while (Paseo quit or crashed, the plugin gone), it restores sleep. State is only
 * let go once `pmset -g` confirms sleep is back; what the tile shows is read from there, never
 * assumed.
 */

const PMSET = "/usr/bin/pmset";
const IOREG = "/usr/sbin/ioreg";
const PROFILER = "/usr/sbin/system_profiler";
const SUDO = "/usr/bin/sudo";
export const SUDOERS_FILE = "/etc/sudoers.d/paseo-caffeine";
export const LID_FILE = join(homedir(), ".jobby-jobs", "caffeine-lid.json");
/** Below this, on battery, lid mode ends by itself. */
export const LID_LOW_BATTERY = 20;
/** The guard fires this long after the deadline, so the plugin's own tick normally wins. */
const GUARD_GRACE_MS = 60_000;
export const GUARD_LABEL = "com.paseo.caffeine.lid-guard";
export const GUARD_PLIST = join(homedir(), "Library", "LaunchAgents", `${GUARD_LABEL}.plist`);
/** Where Caffeine tells the guard of lid mode with no end that it is still watching. */
export const HEARTBEAT_FILE = join(homedir(), ".jobby-jobs", "caffeine-lid-heartbeat");
/** That guard restores sleep once Caffeine has been quiet this long: long enough to ride out a
 *  restart or an update of Paseo, short enough that a closed Mac is not left unwatched. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
const NO_GUARD =
  "could not arm the guard that turns this off (is Caffeine's background item allowed in System Settings → General → Login Items?)";

const ON = ["-a", "disablesleep", "1"] as const;
const OFF = ["-a", "disablesleep", "0"] as const;

/** The one sudoers line: these two exact commands, for this user, and nothing else. */
export function sudoersRule(user: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) throw new Error(`unexpected user name: ${user}`);
  return `${user} ALL=(root) NOPASSWD: ${PMSET} ${ON.join(" ")}, ${PMSET} ${OFF.join(" ")}`;
}

/**
 * Run as root once. The rule is checked by visudo before it is put in place, so a bad line
 * can never land in /etc/sudoers.d and lock sudo up.
 */
export function setupScript(rule: string): string {
  return [
    "set -e",
    'tmp="$(/usr/bin/mktemp)"',
    `/usr/bin/printf '%s\\n' '${rule}' > "$tmp"`,
    '/usr/sbin/visudo -cf "$tmp" >/dev/null',
    `/usr/bin/install -m 0440 -o root -g wheel "$tmp" ${SUDOERS_FILE}`,
    '/bin/rm -f "$tmp"',
    "",
  ].join("\n");
}

/** A path as one single-quoted sh word. */
const shellWord = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;

/** The files the plugin and the LaunchAgent guard share for the heat guard (see thermal.ts). */
export const HEAT_FILES = {
  /** The settings, as `KEY=number` lines the guard can read without running anything. */
  conf: join(homedir(), ".jobby-jobs", "caffeine-thermal.conf"),
  /** A trip: lid mode stays off until the Mac has cooled down. */
  latch: join(homedir(), ".jobby-jobs", "caffeine-thermal-latch"),
  /** Taken by whichever of the two is putting the Mac to sleep. */
  lock: join(homedir(), ".jobby-jobs", "caffeine-thermal.lock"),
  /** While this file exists, the heat guard only says what it would have done. */
  dryRun: join(homedir(), ".jobby-jobs", "caffeine-thermal-dryrun"),
  /** "<caffeinate pid> <plugin pid>": how the guard knows Caffeine's own caffeinate. */
  keeperPid: join(homedir(), ".jobby-jobs", "caffeine-keeper.pid"),
  /** Written just before the plugin replaces the guard, so the old one leaves sleep alone. */
  handover: join(homedir(), ".jobby-jobs", "caffeine-guard-handover"),
  log: join(homedir(), ".jobby-jobs", "caffeine-guard.log"),
};
export type HeatFilePaths = typeof HEAT_FILES;

/** How often the guard looks at the heat, and at its deadline or Caffeine's heartbeat. */
export const GUARD_EVERY_S = 15;

/**
 * How every guard ends: sleep back on, then it removes itself. Up to half an hour of attempts,
 * a minute apart; it removes itself only once `pmset -g` shows sleep is back, or when it has
 * run out of attempts.
 */
function restoreAndLeave(): string[] {
  return [
    "i=0",
    `while [ "$i" -lt 30 ]; do $SUDO -n $PMSET ${OFF.join(" ")}; if $PMSET -g | /usr/bin/grep -q 'SleepDisabled[[:space:]]*0'; then break; fi; i=$((i + 1)); /bin/sleep 60; done`,
    `/bin/rm -f ${shellWord(GUARD_PLIST)}`,
    `/bin/launchctl bootout gui/$(/usr/bin/id -u)/${GUARD_LABEL}`,
  ];
}

/**
 * The heat guard in sh: the rules of server/thermal.ts, read from the same settings file,
 * acting through the same sequence as server/emergency.server.ts, so lid mode stays covered
 * with Paseo, the plugin, the relay and the network all gone. Pressure and the battery come
 * from notifyutil and ioreg, which every Mac has; the fans only when the plugin has built the
 * sensor helper. Every command can be swapped through a CAFFEINE_* variable, for the tests
 * only: launchd starts the guard with none of them set.
 *
 * It also catches TERM: launchd sends it at logout, when a LaunchAgent ends and nothing would
 * switch sleep back on, so it does that first — unless the plugin has just written the
 * handover file, which means a new guard is taking over and lid mode goes on.
 */
export function heatShell(files: HeatFilePaths = HEAT_FILES): string {
  const word = shellWord;
  return [
    "PMSET=${CAFFEINE_PMSET:-/usr/bin/pmset}",
    "SUDO=${CAFFEINE_SUDO:-/usr/bin/sudo}",
    "NOTIFYUTIL=${CAFFEINE_NOTIFYUTIL:-/usr/bin/notifyutil}",
    "IOREG=${CAFFEINE_IOREG:-/usr/sbin/ioreg}",
    "PS=${CAFFEINE_PS:-/bin/ps}",
    "CLOCK=${CAFFEINE_CLOCK:-}",
    "VERIFY_S=${CAFFEINE_VERIFY_S:-20}",
    "SETTLE_S=${CAFFEINE_SETTLE_S:-2}",
    `CONF=${word(files.conf)}; LATCH=${word(files.latch)}; LOCK=${word(files.lock)}; DRY=${word(files.dryRun)}; KEEPER=${word(files.keeperPid)}; HANDOVER=${word(files.handover)}`,
    "PL=2; PD=60; FP=85; FD=60; HELPER=; S1=; S2=; BH=0; BS=; FS=; LR=0",
    'now() { if [ -n "$CLOCK" ]; then $CLOCK; else /bin/date +%s; fi; }',
    "log() { echo \"$(/bin/date '+%Y-%m-%d %H:%M:%S') caffeine guard: $*\"; }",
    "num() { case \"$1\" in ''|*[!0-9]*) return 1;; esac; return 0; }",
    "nap() { /bin/sleep \"$1\" & wait $!; }",
    "read_conf() {",
    "  PL=2; PD=60; FP=85; FD=60; HELPER=",
    '  [ -f "$CONF" ] || return 0',
    "  while IFS='=' read -r key value; do",
    '    case "$key" in',
    '      PRESSURE_LEVEL) case "$value" in 1|2) PL=$value;; esac;;',
    '      PRESSURE_DELAY) if num "$value" && [ "$value" -ge 30 ] && [ "$value" -le 600 ]; then PD=$value; fi;;',
    '      FAN_PCT) if num "$value" && [ "$value" -ge 5 ] && [ "$value" -le 95 ]; then FP=$value; fi;;',
    '      FAN_DELAY) if num "$value" && [ "$value" -ge 30 ] && [ "$value" -le 300 ]; then FD=$value; fi;;',
    '      HELPER) case "$value" in /*) HELPER=$value;; esac;;',
    "    esac",
    '  done < "$CONF"',
    "}",
    "pressure() { p=$($NOTIFYUTIL -g com.apple.system.thermalpressurelevel 2>/dev/null | /usr/bin/awk '{print $NF}'); case \"$p\" in 0|1|2|3|4) echo \"$p\";; esac; }",
    "battery() { t=$($IOREG -rn AppleSmartBattery 2>/dev/null | /usr/bin/awk '/^[ \\t]*\"Temperature\" = [0-9]+[ \\t]*$/ {print $NF; exit}'); if num \"$t\"; then echo \"$t\"; fi; }",
    "lid_closed() { $IOREG -r -k AppleClamshellState -d 4 2>/dev/null | /usr/bin/grep -q '\"AppleClamshellState\" = Yes'; }",
    'fans_pct() { if [ -n "$HELPER" ] && [ -f "$HELPER" ] && [ -x "$HELPER" ]; then f=$("$HELPER" --fans-pct 2>/dev/null); if num "$f"; then echo "$f"; fi; fi; }',
    "holders() { $PMSET -g assertions 2>/dev/null | /usr/bin/awk '/PreventSystemSleep named:/ { sub(/^[ \\t]*pid [0-9]+\\(/, \"\"); sub(/\\).*/, \"\"); print }' | /usr/bin/sort -u | /usr/bin/tr '\\n' ' '; }",
    "allow_sleep() {",
    "  i=0",
    '  while [ "$i" -lt 3 ]; do',
    `    $SUDO -n $PMSET ${OFF.join(" ")} >/dev/null 2>&1`,
    "    if ! $PMSET -g 2>/dev/null | /usr/bin/grep -q 'SleepDisabled[[:space:]]*1'; then return 0; fi",
    '    i=$((i + 1)); nap "$SETTLE_S"',
    "  done",
    "  return 1",
    "}",
    // Only Caffeine's own: the pid it wrote, still a caffeinate tied to the plugin's pid.
    "stop_own_caffeinate() {",
    '  [ -f "$KEEPER" ] || return 0',
    '  read -r cpid ppid < "$KEEPER" || return 0',
    '  if ! num "$cpid" || ! num "$ppid"; then return 0; fi',
    '  args=$($PS -o args= -p "$cpid" 2>/dev/null)',
    '  case "$args" in *caffeinate*"-w $ppid"*) ;; *) return 0;; esac',
    '  kill -TERM "$cpid" 2>/dev/null; nap "$SETTLE_S"',
    '  if kill -0 "$cpid" 2>/dev/null; then kill -KILL "$cpid" 2>/dev/null; fi',
    '  log "stopped Caffeine\'s caffeinate ($cpid)"',
    "}",
    "emergency() {",
    '  reason=$1; detail=$2',
    '  if [ -e "$DRY" ]; then',
    '    [ -f "$LATCH" ] || printf \'at=%s\\nreason=%s\\ndetail=%s\\ndry=1\\nby=guard\\n\' "$(now)" "$reason" "$detail" > "$LATCH"',
    '    log "dry run: would put the Mac to sleep ($reason: $detail)"',
    "    return 0",
    "  fi",
    // A lock older than five minutes was left by a crash (the plugin's rule too): taken over.
    '  if ! /bin/mkdir "$LOCK" 2>/dev/null; then',
    '    held=$(( $(/bin/date +%s) - $(/usr/bin/stat -f %m "$LOCK" 2>/dev/null || /bin/date +%s) ))',
    '    if [ "$held" -lt 300 ]; then log "$reason seen; the plugin is already on it"; return 0; fi',
    '    /bin/rmdir "$LOCK" 2>/dev/null',
    '    if ! /bin/mkdir "$LOCK" 2>/dev/null; then log "$reason seen; the lock is taken"; return 0; fi',
    '    log "took over a lock left $held s ago"',
    "  fi",
    '  printf \'at=%s\\nreason=%s\\ndetail=%s\\ndry=0\\nby=guard\\n\' "$(now)" "$reason" "$detail" > "$LATCH"',
    '  log "putting the Mac to sleep ($reason: $detail)"',
    "  try=1; slept=0",
    '  while [ "$try" -le 3 ]; do',
    '    allow_sleep || log "sleep could not be switched back on (SleepDisabled is still 1)"',
    "    stop_own_caffeinate",
    "    t0=$(now)",
    "    $PMSET sleepnow >/dev/null 2>&1",
    '    nap "$VERIFY_S"',
    "    t1=$(now)",
    // A process does not run while the Mac sleeps: the wall clock running ahead is the sleep.
    '    if [ $((t1 - t0 - VERIFY_S)) -ge 15 ]; then slept=1; break; fi',
    "    try=$((try + 1))",
    "  done",
    '  echo "slept=$slept" >> "$LATCH"',
    '  if [ "$slept" = 1 ]; then log "the Mac slept"; else h=$(holders); echo "holders=$h" >> "$LATCH"; log "sleep did not take; held by: $h"; fi',
    '  /bin/rmdir "$LOCK" 2>/dev/null',
    "  return 0",
    "}",
    // While a real latch holds: sleep stays allowed, and a Mac woken with the lid closed goes
    // back down, at most once a minute.
    "latch_duty() {",
    '  [ -e "$DRY" ] && return 0',
    "  /usr/bin/grep -q '^dry=1' \"$LATCH\" && return 0",
    "  if $PMSET -g 2>/dev/null | /usr/bin/grep -q 'SleepDisabled[[:space:]]*1'; then allow_sleep; fi",
    "  lid_closed || return 0",
    "  t_now=$(now)",
    '  [ $((t_now - LR)) -ge 60 ] || return 0',
    "  LR=$t_now",
    "  stop_own_caffeinate",
    '  log "latched with the lid closed: back to sleep"',
    "  $PMSET sleepnow >/dev/null 2>&1",
    "}",
    "heat_tick() {",
    '  if [ -f "$LATCH" ]; then latch_duty; return 0; fi',
    "  read_conf",
    "  t_now=$(now); p=$(pressure); b=$(battery); closed=0",
    "  if lid_closed; then closed=1; fi",
    '  if [ -n "$p" ] && [ "$p" -ge 3 ]; then emergency trapping "Trapping"; return 0; fi',
    '  if [ -n "$p" ]; then',
    '    if [ "$p" -ge 1 ]; then [ -n "$S1" ] || S1=$t_now; else S1=; fi',
    '    if [ "$p" -ge 2 ]; then [ -n "$S2" ] || S2=$t_now; else S2=; fi',
    "  fi",
    '  HD=$PD; if [ "$PL" = 1 ] && [ "$HD" -gt 60 ]; then HD=60; fi',
    '  if [ -n "$S2" ] && [ $((t_now - S2)) -ge "$HD" ]; then emergency pressure "Heavy $HD s"; return 0; fi',
    '  if [ "$PL" = 1 ] && [ -n "$S1" ] && [ $((t_now - S1)) -ge "$PD" ]; then emergency pressure "Moderate $PD s"; return 0; fi',
    '  if [ -n "$b" ]; then if [ "$b" -ge 4500 ]; then BH=$((BH + 1)); else BH=0; fi; fi',
    '  if [ "$BH" -ge 2 ]; then emergency battery "$((b / 100)).$(((b % 100) / 10)) °C"; return 0; fi',
    '  if [ "$closed" = 1 ] && [ -z "$p" ] && [ -z "$b" ]; then [ -n "$BS" ] || BS=$t_now; else BS=; fi',
    '  if [ -n "$BS" ] && [ $((t_now - BS)) -ge 90 ]; then emergency blind "90 s"; return 0; fi',
    "  f=; if [ \"$closed\" = 1 ]; then f=$(fans_pct); fi",
    '  if [ -z "$f" ]; then FS=; elif [ "$f" -ge "$FP" ]; then [ -n "$FS" ] || FS=$t_now; elif [ "$f" -lt $((FP - 10)) ]; then FS=; fi',
    '  if [ -n "$FS" ] && [ $((t_now - FS)) -ge "$FD" ]; then emergency fans "$f % $FD s"; return 0; fi',
    "  return 0",
    "}",
    "on_term() {",
    '  if [ -f "$HANDOVER" ]; then age=$(( $(/bin/date +%s) - $(/usr/bin/stat -f %m "$HANDOVER" 2>/dev/null || echo 0) )); if [ "$age" -lt 60 ]; then log "a new guard takes over"; exit 0; fi; fi',
    '  log "stopping: sleep back on first"',
    `  $SUDO -n $PMSET ${OFF.join(" ")} >/dev/null 2>&1`,
    "  exit 0",
    "}",
    "trap on_term TERM",
  ].join("\n");
}

/** A guard's script as a LaunchAgent. RunAtLoad makes launchd start it again at the next
 *  login after a reboot; KeepAlive brings back a guard that died, but not one that finished.
 *  One label for every guard: there is one lid mode at a time. */
function agentPlist(script: string): string {
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${GUARD_LABEL}</string>`,
    "<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>",
    `<string>${escape(script)}</string></array>`,
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    `<key>StandardOutPath</key><string>${escape(HEAT_FILES.log)}</string>`,
    `<key>StandardErrorPath</key><string>${escape(HEAT_FILES.log)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

/**
 * The guard of a timer: a LaunchAgent that watches the heat until the deadline, then restores
 * sleep and removes itself. After a reboot the wait is whatever is left (or none).
 */
export function guardPlist(untilMs: number, files: HeatFilePaths = HEAT_FILES): string {
  const at = Math.ceil(untilMs / 1000);
  return agentPlist(
    [
      heatShell(files),
      `while [ $((${at} - $(/bin/date +%s))) -gt 0 ]; do heat_tick; nap ${GUARD_EVERY_S}; done`,
      ...restoreAndLeave(),
    ].join("\n"),
  );
}

/**
 * The wait of the guard of lid mode with no end: every `everyS` seconds it runs `onTick` (the
 * heat check) and looks at when Caffeine last beat (the heartbeat file's time), and stops
 * waiting once that is `staleS` seconds ago. Never counted from before the guard's own start,
 * so after a reboot Paseo gets the same time from login to pick lid mode up again.
 */
export function heartbeatWait(heartbeat: string, staleS: number, everyS = 60, onTick = ""): string {
  const file = shellWord(heartbeat);
  return [
    "started=$(/bin/date +%s)",
    `while :; do ${onTick ? `${onTick}; ` : ""}/bin/sleep ${everyS} & wait $!; last=$started; if [ -f ${file} ]; then beat=$(/usr/bin/stat -f %m ${file}); if [ "$beat" -gt "$last" ]; then last=$beat; fi; fi; if [ $(($(/bin/date +%s) - $last)) -ge ${staleS} ]; then break; fi; done`,
  ].join("; ");
}

/** The guard of lid mode with no end: it watches the heat and waits for Caffeine to go quiet
 *  (see heartbeatWait), then restores sleep and removes itself. */
export function heartbeatGuardPlist(heartbeat: string, staleMs: number, files: HeatFilePaths = HEAT_FILES): string {
  return agentPlist(
    [heatShell(files), heartbeatWait(heartbeat, Math.ceil(staleMs / 1000), GUARD_EVERY_S, "heat_tick"), ...restoreAndLeave()].join("\n"),
  );
}

/** `SleepDisabled 1` in `pmset -g`; null when the line is not there. */
export function parseSleepDisabled(output: string): boolean | null {
  const match = /^\s*SleepDisabled\s+(\d)/m.exec(output);
  return match ? match[1] === "1" : null;
}

export interface LidStored {
  /** RFC 3339 deadline, or "" when lid mode is off or has no end. */
  until: string;
  /** The length that was picked, so the tile can count down from it; 0 when off. */
  minutes: number;
  /** On with no end: only a person, a low battery or heat turns it off. */
  forever: boolean;
}

const OFF_STATE: LidStored = { until: "", minutes: 0, forever: false };

const lidStored = z.object({
  until: z.string().default(""),
  minutes: z.number().int().nonnegative().default(0),
  forever: z.boolean().default(false),
});

/**
 * Whether `system_profiler SPDisplaysDataType -json` lists a display other than the built-in
 * one. `displaysleepnow` sleeps every display, so with a monitor in use the lid is left alone.
 * Output that cannot be read counts as external: leaving a lit panel beats blanking a monitor.
 */
export function externalDisplay(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { SPDisplaysDataType?: Array<{ spdisplays_ndrvs?: Array<{ spdisplays_connection_type?: string }> }> };
    const displays = (parsed.SPDisplaysDataType ?? []).flatMap((gpu) => gpu.spdisplays_ndrvs ?? []);
    if (displays.length === 0) return true;
    return displays.some((display) => display.spdisplays_connection_type !== "spdisplays_internal");
  } catch {
    return true;
  }
}

/** `"AppleClamshellState" = Yes` in `ioreg -r -k AppleClamshellState`; null when not there. */
export function parseLidClosed(output: string): boolean | null {
  const match = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(output);
  return match ? match[1] === "Yes" : null;
}

/**
 * Whether `pmset -g therm` reports the Mac running hot: a thermal or performance warning level
 * above 0 that is recorded (macOS prints "Note: No … has been recorded" otherwise), or the CPU
 * held below full speed. Read loosely on purpose: a false alarm only turns lid mode off.
 */
export function thermalWarning(output: string): boolean {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (/^Note: No /i.test(line)) continue;
    if (/warning level/i.test(line)) {
      // A recorded level of 0 is the all-clear after a warm spell; a level that cannot be read
      // counts as hot.
      const level = /warning level[^0-9]*(\d+)/i.exec(line);
      if (level === null || Number(level[1]) > 0) return true;
      continue;
    }
    const limit = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(line);
    if (limit !== null && Number(limit[1]) < 100) return true;
  }
  return false;
}

export async function readLid(path: string = LID_FILE): Promise<LidStored> {
  try {
    const parsed = lidStored.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : { ...OFF_STATE };
  } catch {
    return { ...OFF_STATE };
  }
}

export async function writeLid(value: LidStored, path: string = LID_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export interface LidDeps {
  /** Runs a command, never asking for a password; resolves with its exit code and output. */
  run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }>;
  /** Runs a shell script as root through macOS's own password (or Touch ID) dialog. */
  admin(script: string): Promise<void>;
  /** Whether setup's sudoers rule is in place: its file exists, which needs no root to see. */
  ruleInstalled(): Promise<boolean>;
  /** Arms the guard to restore sleep at `untilMs`, replacing any earlier one; false if it
   *  could not be armed. */
  startGuard(untilMs: number): Promise<boolean>;
  /** Arms the guard of lid mode with no end, which restores sleep once `beat` has gone quiet
   *  (see heartbeatGuardPlist), replacing any earlier one; false if it could not be armed. */
  startHeartbeatGuard(): Promise<boolean>;
  /** Tells that guard Caffeine is still watching. */
  beat(): Promise<void>;
  /** Disarms the guard, if there is one. */
  stopGuard(): Promise<void>;
  read(): Promise<LidStored>;
  write(value: LidStored): Promise<void>;
  user(): string;
  /** The heat guard's say before lid mode comes on: "cooling" while a trip has not cooled
   *  down (see heat.server.ts). Absent: always allowed. */
  gate?(): Promise<"ok" | "cooling">;
  /** Whether the heat guard has tripped: sleep switched back on under a trip reads as heat,
   *  not as somebody's hand. */
  latched?(): boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Lid {
  start(): Promise<void>;
  /** Re-reads the system and ends lid mode at its deadline or on a low battery. */
  tick(battery: Battery | null): Promise<void>;
  /** `untilMs` sets the deadline outright, so lid mode ends with the timer it rides on;
   *  `minutes` is then the length the tile counts down from. */
  enable(minutes: number | "forever", untilMs?: number): Promise<void>;
  /** `by` says who turned it off, for the tile: "sleep" (Sleep now) or "off" (the header). */
  disable(why: string, by?: LidStopped): Promise<void>;
  /** Lid mode off for the heat guard; true once `pmset -g` confirms sleep is back. */
  endForHeat(): Promise<boolean>;
  setup(): Promise<void>;
  /** Keeps the display asleep while the lid is closed and lid mode is on, checked once a
   *  minute; never while an external monitor is attached. */
  checkClosed(): Promise<void>;
  status(): LidStatus;
}

export function createLid(deps: LidDeps): Lid {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);

  let stored: LidStored = { ...OFF_STATE };
  let setup: LidSetup = "unknown";
  /** From `pmset -g`; null when it could not be read, which is not the same as off. */
  let on: boolean | null = null;
  let error = "";

  // One operation at a time: the timer, a mode change and two clients can all reach here, and
  // a "turn off" overtaken by a "turn on" must not undo the new deadline.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  }

  /** The deadline, or 0 (already due) when it is missing or does not parse. */
  const deadline = () => {
    const at = Date.parse(stored.until);
    return Number.isNaN(at) ? 0 : at;
  };

  async function readPermission(): Promise<void> {
    // The rule's own file first: `sudo -l` says whether pmset is allowed at all, not whether it
    // is allowed without a password, and it answers without one once the user has any NOPASSWD
    // rule. An admin with another app's such rule looked ready and then failed on the switch.
    if (!(await deps.ruleInstalled().catch(() => false))) {
      setup = "needs-setup";
      return;
    }
    const allowed = await deps.run(SUDO, ["-n", "-l", PMSET, ...ON]).catch(() => ({ code: 1, stdout: "" }));
    setup = allowed.code === 0 ? "ready" : "needs-setup";
  }

  async function readSleep(): Promise<void> {
    const settings = await deps.run(PMSET, ["-g"]).catch(() => ({ code: 1, stdout: "" }));
    on = settings.code === 0 ? parseSleepDisabled(settings.stdout) : null;
  }

  async function pmset(args: readonly string[]): Promise<void> {
    const result = await deps.run(SUDO, ["-n", PMSET, ...args]);
    if (result.code !== 0) throw new Error(`pmset ${args.join(" ")} failed (exit ${result.code})`);
  }

  async function save(next: LidStored): Promise<void> {
    stored = next;
    await deps.write(stored);
  }

  /** The lid as last seen, to log its changes and look for a monitor once per closing. */
  let wasClosed = false;
  /** Whether a monitor other than the built-in one was in use at this closing; null: not asked. */
  let externalSeen: boolean | null = null;

  /** Why lid mode last ended on its own, for the tile; cleared when it is turned on again. */
  let ended: "" | "battery" | "heat" = "";
  /** Who else turned it off, for the tile; cleared the same way. At most one of the two is
   *  set: the latest reason replaces any earlier one, so the tile never names a stale one. */
  let stopped: LidStopped | "" = "";
  const because = (why: { ended?: "battery" | "heat"; stopped?: LidStopped }) => {
    ended = why.ended ?? "";
    stopped = why.stopped ?? "";
  };

  /** Whether lid mode is on by Caffeine's own record: timed or forever. */
  const running = () => stored.until !== "" || stored.forever;

  async function hot(): Promise<boolean> {
    const answer = await deps.run(PMSET, ["-g", "therm"]).catch(() => ({ code: 1, stdout: "" }));
    return answer.code === 0 && thermalWarning(answer.stdout);
  }

  /** Sleep back on. The deadline and the guard are only let go once the system confirms it;
   *  until then the next tick tries again and the guard stays armed. */
  async function restore(why: string): Promise<void> {
    let failed = "";
    try {
      await pmset(OFF);
    } catch (failure) {
      failed = failure instanceof Error ? failure.message : String(failure);
    }
    await readSleep();
    // Back on, whoever did it (a failed command next to a Mac put right by hand included).
    if (on !== false) {
      error = failed || (on === null ? "could not read whether sleep is back" : "sleep is still switched off");
      log(`caffeine: lid mode could not be turned off (${why}): ${error}`);
      return;
    }
    error = "";
    await deps.stopGuard().catch(() => undefined);
    await save(OFF_STATE);
    log(`caffeine: lid mode off (${why})`);
  }

  /**
   * The guard of whatever runs now, after an attempt at something else failed: arming a guard
   * boots the one before out first, so it may be gone. A timer gets its deadline back, no end
   * its heartbeat, off none. A session whose guard cannot come back is ended rather than left
   * without one.
   */
  async function rearm(): Promise<void> {
    if (!running()) {
      await deps.stopGuard().catch(() => undefined);
      return;
    }
    const armed = stored.forever ? await deps.startHeartbeatGuard() : await deps.startGuard(deadline() + GUARD_GRACE_MS);
    if (!armed) await restore("guard could not be armed");
  }

  /** Tells the guard of lid mode with no end that Caffeine is still watching. A beat that
   *  cannot be written lets the guard step in, which is the safe way round. */
  const beat = () => deps.beat().catch((failure) => log(`caffeine: lid heartbeat failed: ${String(failure)}`));

  return {
    start: () =>
      serial(async () => {
        stored = await deps.read();
        await readPermission();
        await readSleep();
        if (!running()) return;
        if (stored.forever) {
          // Turned back on while Paseo was down, by hand or by the guard: nothing to keep.
          if (on === false) {
            await deps.stopGuard().catch(() => undefined);
            await save(OFF_STATE);
            return;
          }
          // Still running: re-arm the guard, in case the one from before did not survive.
          if (!(await deps.startHeartbeatGuard())) await restore("guard could not be armed");
          return;
        }
        // A deadline that passed while Paseo was down: put sleep back now.
        if (deadline() <= now()) return restore("deadline passed while stopped");
        // Still running: re-arm the guard, in case the one from before did not survive.
        if (!(await deps.startGuard(deadline() + GUARD_GRACE_MS))) await restore("guard could not be armed");
      }),

    tick: (battery) =>
      serial(async () => {
        await readSleep();
        if (!running()) return;
        // The guard of lid mode with no end waits for this.
        if (stored.forever) await beat();
        if (!stored.forever && deadline() <= now()) return restore("time is up");
        if (battery !== null && !battery.external && battery.percent < LID_LOW_BATTERY) {
          await restore(`battery at ${battery.percent}%`);
          if (!running()) because({ ended: "battery" });
          return;
        }
        if (await hot()) {
          await restore("the Mac is running hot");
          if (!running()) because({ ended: "heat" });
          return;
        }
        // Turned back on by hand (`pmset -a disablesleep 0`), or by the heat guard's sh half:
        // nothing left to time.
        if (on === false) {
          await deps.stopGuard().catch(() => undefined);
          await save(OFF_STATE);
          because(deps.latched?.() ? { ended: "heat" } : { stopped: "manual" });
        }
      }),

    enable: (minutes, untilMs) =>
      serial(async () => {
        // A new attempt: whatever turned lid mode off before is no longer the news, even if
        // this one fails (its failure is shown on its own).
        because({});
        // A trip that has not cooled down keeps lid mode off, whoever asks: the heat guard
        // let the Mac sleep for a reason.
        if (deps.gate && (await deps.gate()) === "cooling") {
          error = "cooling";
          because({ ended: "heat" });
          return;
        }
        await readPermission();
        if (setup !== "ready") {
          error = "needs-setup";
          return;
        }
        if (minutes === "forever") {
          // The guard first, as under a timer: sleep is never switched off without something
          // set to bring it back. With no end to wait for, this one waits for Caffeine to go
          // quiet and restores sleep then; while Caffeine runs, the battery and heat checks
          // and a person turn it off. A failure leaves what ran before as it was, its guard
          // included.
          if (!(await deps.startHeartbeatGuard())) {
            await rearm();
            error = NO_GUARD;
            return;
          }
          try {
            await pmset(ON);
          } catch (failure) {
            await rearm();
            error = failure instanceof Error ? failure.message : String(failure);
            await readSleep();
            return;
          }
          error = "";
          // A lid already closed when lid mode comes on counts as just closed.
          wasClosed = false;
          externalSeen = null;
          await save({ until: "", minutes: 0, forever: true });
          await readSleep();
          log("caffeine: lid mode on with no end");
          return;
        }
        const until = untilMs ?? now() + minutes * 60_000;
        // The guard first: sleep is never switched off without something set to bring it back.
        if (!(await deps.startGuard(until + GUARD_GRACE_MS))) {
          await rearm();
          error = NO_GUARD;
          return;
        }
        try {
          await pmset(ON);
        } catch (failure) {
          await rearm();
          error = failure instanceof Error ? failure.message : String(failure);
          await readSleep();
          return;
        }
        error = "";
        wasClosed = false;
        externalSeen = null;
        await save({ until: new Date(until).toISOString(), minutes, forever: false });
        await readSleep();
        log(`caffeine: lid mode on for ${minutes} min`);
      }),

    disable: (why, by) =>
      serial(async () => {
        await restore(why);
        // Only once sleep is confirmed back: a turn-off that did not take names no one. A
        // mode change (no `by`) clears the reason, since the tile has nothing to explain then.
        if (on === false) because(by ? { stopped: by } : {});
      }),

    endForHeat: () =>
      serial(async () => {
        await restore("heat guard");
        if (on === false) because({ ended: "heat" });
        return on === false;
      }),

    // Outside the queue on purpose: the password dialog waits for a person, possibly minutes,
    // and the ticks behind it (which the whole controller waits on) must not. It only touches
    // `setup` and `error`.
    async setup() {
      try {
        await deps.admin(setupScript(sudoersRule(deps.user())));
        error = "";
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        // Cancelling the password dialog is a choice, not a failure.
        error = /-128|cancel/i.test(message) ? "" : message;
      }
      await readPermission();
    },

    async checkClosed() {
      // Only lid mode needs the lid: without it macOS sleeps a closed Mac anyway. Turning it on
      // starts the lid's story afresh (see enable), so nothing is lost by not looking meanwhile.
      if (!running() || on !== true) return;
      const seen = await deps.run(IOREG, ["-r", "-k", "AppleClamshellState", "-d", "4"]).catch(() => ({ code: 1, stdout: "" }));
      const read = parseLidClosed(seen.stdout);
      // Unknown is neither: nothing changes until the lid can be read again.
      if (seen.code !== 0 || read === null) return;
      const justClosed = read && !wasClosed;
      if (read !== wasClosed) {
        log(`caffeine: lid ${read ? "closed" : "opened"}`);
        externalSeen = null;
      }
      wasClosed = read;
      if (!read) return;
      // A monitor found stays found until the lid opens. "None" is asked again every time: one
      // plugged in after the lid closed must not be blanked every minute.
      if (externalSeen !== true) {
        const displays = await deps.run(PROFILER, ["SPDisplaysDataType", "-json"]).catch(() => ({ code: 1, stdout: "" }));
        externalSeen = displays.code !== 0 || externalDisplay(displays.stdout);
      }
      if (externalSeen) return;
      // Every check while the lid stays shut, not only on closing: whatever wakes the panel
      // under a closed lid (a missed closing, a notification) is put right within a minute. A
      // display already asleep is left as it is.
      await deps.run(PMSET, ["displaysleepnow"]).catch(() => undefined);
      if (justClosed) log("caffeine: lid closed, display put to sleep");
    },

    status: () => ({ on: on === true, until: stored.until, minutes: stored.minutes, forever: stored.forever, ended, stopped, setup, error }),
  };
}

function runCommand(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 10_000 }, (failure, stdout) => {
      const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

/** The real thing: execFile, osascript, a detached sh, and `ps` to recognise our own guard. */
/** What arming the guard needs from the system; a parameter so the order can be tested. */
export interface ArmIo {
  run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  wait(ms: number): Promise<void>;
  domain: string;
  log(line: string): void;
}

/**
 * Loads `plist` as the guard, replacing any earlier one; false if launchd refused it. The
 * order matters. The old guard switches sleep back on when it is stopped (it cannot tell a
 * logout from a replacement), unless the handover file says a new one is taking over; and
 * `launchctl bootout` returns before that guard has finished handling its TERM. So: the
 * handover file first, then bootout, then wait until launchd has let go of the old job —
 * bootstrapping before that fails with 5 (I/O error) — then bootstrap, with one retry, and only
 * then the handover file goes.
 */
export async function armGuard(plist: string, io: ArmIo): Promise<boolean> {
  const service = `${io.domain}/${GUARD_LABEL}`;
  try {
    await io.write(HEAT_FILES.handover, `${Date.now()}\n`);
    await io.run("/bin/launchctl", ["bootout", service]);
    for (let i = 0; i < 50; i += 1) {
      if ((await io.run("/bin/launchctl", ["print", service])).code !== 0) break;
      await io.wait(100);
    }
    await io.write(GUARD_PLIST, plist);
    let loaded = await io.run("/bin/launchctl", ["bootstrap", io.domain, GUARD_PLIST]);
    if (loaded.code !== 0) {
      await io.wait(1000);
      loaded = await io.run("/bin/launchctl", ["bootstrap", io.domain, GUARD_PLIST]);
    }
    if (loaded.code !== 0) io.log(`caffeine: lid guard did not load (exit ${loaded.code})`);
    return loaded.code === 0;
  } catch (failure) {
    io.log(`caffeine: lid guard failed: ${String(failure)}`);
    return false;
  } finally {
    await io.remove(HEAT_FILES.handover).catch(() => undefined);
  }
}

export function systemLidDeps(log: (line: string) => void): LidDeps {
  const arm = (plist: string) =>
    armGuard(plist, {
      run: runCommand,
      write: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, { mode: 0o644 });
      },
      remove: (path) => rm(path, { force: true }),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      domain: `gui/${process.getuid?.() ?? userInfo().uid}`,
      log,
    });

  return {
    run: runCommand,
    admin: async (script) => {
      const dir = await mkdtemp(join(tmpdir(), "caffeine-lid-"));
      const file = join(dir, "setup.sh");
      try {
        await writeFile(file, script, { mode: 0o700 });
        const prompt = "Caffeine wants to let this Mac keep running with the lid closed. This allows only that one power setting.";
        const quoted = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const apple = `do shell script "/bin/sh " & quoted form of "${quoted}" with prompt "${prompt}" with administrator privileges`;
        await new Promise<void>((resolve, reject) => {
          execFile("/usr/bin/osascript", ["-e", apple], { timeout: 5 * 60_000 }, (failure, _out, stderr) =>
            failure ? reject(new Error(String(stderr).trim() || failure.message)) : resolve(),
          );
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    ruleInstalled: () => access(SUDOERS_FILE).then(() => true, () => false),
    startGuard: (untilMs) => arm(guardPlist(untilMs)),
    startHeartbeatGuard: () => arm(heartbeatGuardPlist(HEARTBEAT_FILE, HEARTBEAT_STALE_MS)),
    beat: async () => {
      await mkdir(dirname(HEARTBEAT_FILE), { recursive: true });
      await writeFile(HEARTBEAT_FILE, `${new Date().toISOString()}\n`);
    },
    stopGuard: async () => {
      const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
      await runCommand("/bin/launchctl", ["bootout", `${domain}/${GUARD_LABEL}`]);
      await rm(GUARD_PLIST, { force: true });
    },
    read: () => readLid(),
    write: (value) => writeLid(value),
    user: () => userInfo().username,
    log,
  };
}
