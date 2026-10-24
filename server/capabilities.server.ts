import { defineRpc, type PluginRpcContract } from "@getpaseo/plugin";
import { type ZodType, z } from "zod";
import {
  dismissThermal,
  getStatus,
  runWarmup,
  setLid,
  setMode,
  setOptions,
  setOptionsInput,
  setWarmup,
  sleepNow,
  timerMinutes,
  warmupTime,
} from "../shared/caffeine.shared.ts";

/**
 * What an assistant outside Paseo may do with this plugin — God Mode, which drives Paseo from
 * ChatGPT over the relay. Paseo hands a remote client only plugin ids and a blind
 * `invokePluginRpc`: no list of methods, no schemas, nothing that says which call reads and
 * which one puts the Mac to sleep. So the plugin says it itself, under a method every plugin
 * can answer the same way.
 *
 * Every operation points at a real RPC of this plugin, and the arguments it advertises are
 * rendered from the same zod contracts the handlers parse with, so the description cannot
 * promise an argument the handler would refuse. `fixed` turns one RPC into several plain
 * operations: "keep awake" and "let it sleep" are both `caffeine.set`, with a different mode
 * that the caller cannot override.
 *
 * Everything Caffeine reads and every change it offers is described here, or listed in
 * NOT_FOR_ASSISTANTS or HIDDEN_FIELDS below with the reason it is not. The tests in
 * server/capabilities.test.ts fail on a new RPC or status field until it is one or the other
 * (README, "Definition of Done").
 */

export const CAPABILITIES_SCHEMA = "paseo.capabilities/1";

const operation = z.object({
  id: z.string(),
  kind: z.enum(["read", "action"]),
  method: z.string(),
  title: z.string(),
  description: z.string(),
  /** JSON Schema of the arguments the caller supplies; never the fixed ones. */
  input: z.record(z.string(), z.unknown()),
  fixed: z.record(z.string(), z.unknown()).optional(),
  /** Reads only: what "show me Caffeine" means. */
  default: z.boolean().optional(),
  /** The fields of the answer worth reading out; the rest is noise to a listener. */
  output: z.object({ fields: z.array(z.string()) }).optional(),
  /**
   * Actions only. `low` is local and undone with one more call; `outward` reaches a service in
   * the user's name; `disruptive` can put the Mac to sleep, which pauses its agents and cuts it
   * off from ChatGPT. Anything but `low` is confirmed first.
   */
  risk: z.enum(["low", "outward", "disruptive", "destructive"]).optional(),
  confirm: z.enum(["none", "always"]).optional(),
  /** What the user hears before a confirmed action runs. */
  confirmText: z.string().optional(),
  /**
   * Actions only: the field of the answer that says nothing was done (server/actions.server.ts),
   * which God Mode then reports as not done. In this schema because the daemon parses the
   * description with it, and would drop a key it does not name.
   */
  outcome: z.object({ error: z.string() }).optional(),
});

export const capabilities = z.object({
  schema: z.literal(CAPABILITIES_SCHEMA),
  title: z.string(),
  summary: z.string(),
  aliases: z.array(z.string()),
  operations: z.array(operation),
});

export type Capabilities = z.output<typeof capabilities>;

export const describeRpc = defineRpc({
  name: "meta.describe",
  input: z.object({}),
  output: capabilities,
});

export interface CaffeineOperation {
  id: string;
  kind: "read" | "action";
  contract: PluginRpcContract;
  title: string;
  description: string;
  /** What the caller supplies; merged under `fixed` it must satisfy the contract's input. */
  input: ZodType;
  fixed?: Record<string, unknown>;
  default?: true;
  /** The top-level fields of the answer to read out. */
  fields: string[];
  risk?: "low" | "outward" | "disruptive";
  confirmText?: string;
}

/**
 * The RPCs this plugin answers that are not offered, and why. Each is a decision: the tests
 * want every RPC either described or here.
 */
export const NOT_FOR_ASSISTANTS: Record<string, string> = {
  "caffeine.lid-setup":
    "Opens macOS's administrator password dialog on the Mac and installs a sudoers rule (/etc/sudoers.d/paseo-caffeine). It needs a person at the Mac, and a password prompt raised from afar is a phishing pattern. The status says lid.setup = needs-setup, so the assistant can send the person there.",
  "settings.preferences.write":
    "The heat guard's sensitivity (pressure level, its delay, the cool-down, the fan threshold and its delay) and the page's tiles. The host stores any values that fit the schema, and the plugin's server cannot vet a write (its settings handle only reads), so describing it would let a remote caller weaken the guard of a hot Mac with its lid closed. The applied values are readable in thermal.settings.",
  "settings.preferences.reset":
    "The same store: puts every preference back to its default, the heat guard's included, with no check the plugin could make first.",
  "settings.preferences.read":
    "The raw preferences: the page's tile choices and the guard's sensitivity as stored. The values the guard applies are in thermal.settings, and the warm-up switch says when its tile is hidden, so nothing an assistant needs is only here.",
  "meta.describe": "This description itself.",
};

/**
 * Status fields no operation returns, and why. Empty: nothing in the status is a secret. The
 * wake link is a LAN address that wakes this Mac and nothing more (the anchor is not
 * authenticated, by design: README, "Things that are the way they are"), and the warm-up's
 * results name each login by its email, as the accounts plugin already does.
 */
export const HIDDEN_FIELDS: Record<string, string> = {};

/** The verdict on one change (server/actions.server.ts): every action answers with it. */
const VERDICT = ["refused", "problem"];
/** Caffeine's own hold: the mode and whether it holds. */
const HOLD = ["mode", "until", "active", "busy", "agents", "error", "keepDisplay"];
/** The lid switch and lid mode itself. */
const LID = ["lidClosed", "lid"];
/** The main read: the hold, lid mode, power, and the way back from sleep. */
const STATUS = [...HOLD, ...LID, "battery", "wakeUrl", "tickAt"];
/** Every status field, for the one read that answers with all of them. */
export const EVERYTHING = [...STATUS, "thermal", "warmup"];

const none = z.object({});

/** Said before every change that can put the Mac to sleep; the user hears it, so no field names. */
const SLEEPS = "the agents pause, and ChatGPT cannot reach the Mac until it is woken, for example with the wake link on the home network";

export const OPERATIONS: CaffeineOperation[] = [
  {
    id: "status",
    kind: "read",
    contract: getStatus,
    default: true,
    title: "Keep-awake, lid and power status",
    description:
      "mode: off, on, timer (ends at until) or auto (while agents work). active: held awake now; busy: an agent ran in the last 3 min; agents: running now; error: why the hold failed. keepDisplay: display held too. lidClosed: the switch letting a timer or On run lid-closed; lid: lid mode (on, until, minutes, forever, ended battery|heat, stopped sleep|off|manual, setup needs-setup = permission missing at the Mac, error). battery: percent, charging, charged, external = on charger, minutes, adapterWatts, inputWatts, batteryWatts (+ in, − out). wakeUrl wakes it on the home network. tickAt: read at.",
    input: none,
    fields: STATUS,
  },
  {
    id: "heat",
    kind: "read",
    contract: getStatus,
    title: "Heat: temperatures, fans and the heat guard",
    description:
      "Read every 15 s. pressure: macOS thermal pressure 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping. cpuC: hottest CPU die °C; batteryC: battery °C (limit 45). fans: each fan's rpm, min, max, manual (another app drives it); [] no fans, null unreadable, sensors says why. lidClosed: the lid is shut now. The heat guard acts only when armed (lid mode on): state normal|warm|pending|blind|latched, pendingReason, firesAt; latch, cool, coolAt: cool-down after a trip; event: last trip; settings: its thresholds. dryRun: it only logs; simulated: fake readings.",
    input: none,
    fields: ["thermal"],
  },
  {
    id: "warmup",
    kind: "read",
    contract: getStatus,
    title: "Session warm-up: schedule and last results",
    description:
      "Session warm-up sends one tiny Haiku message from each Claude subscription login at a set hour, so its 5-hour window starts early. enabled; time: the hour, HH:MM local; nextAt: the next run; lastAt: the last one; results: one per login (login = email and folder, ok, error); running: a warm-up is going on now.",
    input: none,
    fields: ["warmup"],
  },
  {
    id: "everything",
    kind: "read",
    contract: getStatus,
    title: "Everything Caffeine reads, in one answer",
    description: "The status, heat and warm-up reads together, for a full report; the narrower reads suit a single question.",
    input: none,
    fields: EVERYTHING,
  },
  {
    id: "keep_awake",
    kind: "action",
    contract: setMode,
    fixed: { mode: "on" },
    title: "Keep the Mac awake",
    description:
      "Keep the Mac awake until told otherwise; survives a restart of Paseo. With the lid switch on (lidClosed), lid mode comes on too, with no end. problem says what did not take.",
    input: none,
    risk: "low",
    fields: [...HOLD, ...LID, ...VERDICT],
  },
  {
    id: "keep_awake_for",
    kind: "action",
    contract: setMode,
    fixed: { mode: "timer" },
    title: "Keep the Mac awake for a while",
    description:
      "Keep the Mac awake for 30, 60, 120, 180, 480 or 720 minutes, then let it sleep again (mode goes back to off). With the lid switch on, lid mode lasts exactly as long.",
    input: z.object({ minutes: timerMinutes }),
    risk: "low",
    fields: [...HOLD, ...LID, ...VERDICT],
  },
  {
    id: "auto",
    kind: "action",
    contract: setMode,
    fixed: { mode: "auto" },
    title: "Keep the Mac awake while agents work",
    description:
      "Hold the Mac only while an agent runs and for three minutes after the last one; then it may idle to sleep. Ends lid mode, so a Mac with its lid closed sleeps at once.",
    input: none,
    // Not low: when no agent runs it lets the Mac sleep, at once with the lid closed.
    risk: "disruptive",
    confirmText: `Switch Caffeine to While agents work: once no agent has run for three minutes the Mac may fall asleep, and lid mode ends, so with its lid closed it sleeps at once; ${SLEEPS}.`,
    fields: [...HOLD, ...LID, ...VERDICT],
  },
  {
    id: "allow_sleep",
    kind: "action",
    contract: setMode,
    fixed: { mode: "off" },
    title: "Let the Mac sleep again",
    description: "Stop holding the Mac awake and end lid mode: it sleeps when idle, as it normally would, and at once if its lid is closed.",
    input: none,
    // Not low: an idle Mac that falls asleep pauses its agents and drops off the relay.
    risk: "disruptive",
    confirmText: `Stop keeping the Mac awake: it may fall asleep when idle, and at once if its lid is closed; ${SLEEPS}.`,
    fields: [...HOLD, ...LID, "wakeUrl", ...VERDICT],
  },
  {
    id: "keep_display",
    kind: "action",
    contract: setOptions,
    title: "Keep the display on too",
    description: "keepDisplay true holds the display awake along with the system while Caffeine holds the Mac; false lets the display sleep as usual.",
    input: setOptionsInput.pick({ keepDisplay: true }).required(),
    risk: "low",
    fields: [...HOLD, ...VERDICT],
  },
  {
    id: "allow_lid_closed",
    kind: "action",
    contract: setOptions,
    fixed: { lidClosed: true },
    title: "Let the Mac run with the lid closed",
    description:
      "Turn the lid switch on: while a timer or On runs, the Mac keeps running with its lid closed for as long as they last (lid mode; it still ends below 20% battery off the charger, or when the heat guard trips). Refused without the one-time permission, which only a person at the Mac can give.",
    input: none,
    risk: "low",
    fields: ["mode", "until", ...LID, ...VERDICT],
  },
  {
    id: "stop_lid_closed",
    kind: "action",
    contract: setOptions,
    fixed: { lidClosed: false },
    title: "Stop running with the lid closed",
    description: "Turn the lid switch off and lid mode with it: closing the lid sleeps the Mac again, at once if it is closed now.",
    input: none,
    risk: "disruptive",
    confirmText: `Turn the lid switch off: lid mode ends, and if the Mac's lid is closed it sleeps at once; ${SLEEPS}.`,
    fields: ["mode", "until", ...LID, ...VERDICT],
  },
  {
    id: "lid_back_on",
    kind: "action",
    contract: setLid,
    fixed: { lid: "on" },
    title: "Turn lid mode back on",
    description:
      "When Sleep now, the header, a low battery, heat or a hand ended lid mode while a timer or On still runs with the lid switch on: bring it back for the rest of the timer, or with no end under On. Refused when nothing asks for lid mode, without the permission, or while the heat guard cools down.",
    input: none,
    risk: "low",
    fields: ["mode", "until", ...LID, ...VERDICT],
  },
  {
    id: "lid_off_now",
    kind: "action",
    contract: setLid,
    fixed: { lid: "off" },
    title: "Switch sleep back on now",
    description:
      "End lid mode now, also when sleep was switched off by hand, and keep the lid switch for the next timer or On: a closed lid sleeps the Mac again, at once if it is closed now.",
    input: none,
    risk: "disruptive",
    confirmText: `Switch sleep back on: lid mode ends now, and if the Mac's lid is closed it sleeps at once; ${SLEEPS}.`,
    fields: ["mode", "until", ...LID, ...VERDICT],
  },
  {
    id: "sleep_now",
    kind: "action",
    contract: sleepNow,
    title: "Put the Mac to sleep now",
    description:
      "End lid mode if it is on, then sleep a second after answering, from wherever the user is. The answer comes first, so it confirms the request, not the sleep; refused, with nothing asked, when sleep cannot be switched back on.",
    input: none,
    risk: "disruptive",
    confirmText: `Put the Mac to sleep now: ${SLEEPS}.`,
    fields: ["mode", "lid", "wakeUrl", ...VERDICT],
  },
  {
    id: "dismiss_heat_alert",
    kind: "action",
    contract: dismissThermal,
    title: "Dismiss the heat alert",
    description:
      "Put away the banner about the heat guard's last trip (thermal.event). A latch that keeps lid mode off stays until the Mac has cooled down.",
    input: none,
    risk: "low",
    fields: ["thermal", ...VERDICT],
  },
  {
    id: "warmup_on",
    kind: "action",
    contract: setWarmup,
    fixed: { enabled: true },
    title: "Turn Session warm-up on",
    description:
      "Every day at time (HH:MM local; left out, the hour already set) send one tiny Haiku message from each Claude subscription login on this Mac, so its 5-hour window starts early. Refused while warm-up is hidden in Caffeine's Settings.",
    input: z.object({ time: warmupTime.optional() }),
    // Messages go out in the user's name, on every login's subscription.
    risk: "outward",
    confirmText:
      "Turn Session warm-up on: every day at the set hour Caffeine sends one tiny message from each Claude subscription login on this Mac, which starts its 5-hour window; if that hour passed less than half an hour ago, the first goes out within a minute.",
    fields: ["warmup", ...VERDICT],
  },
  {
    id: "warmup_hour",
    kind: "action",
    contract: setWarmup,
    title: "Move Session warm-up's hour",
    description: "Set the hour of the warm-up (time, HH:MM local) and leave it on or off as it is, the way − and + on its tile do.",
    input: z.object({ time: warmupTime }),
    // Moved to an hour that passed less than half an hour ago, an enabled warm-up goes out at once.
    risk: "outward",
    confirmText:
      "Move Session warm-up to {time}: if warm-up is on and that hour passed less than half an hour ago, one tiny message goes out from every Claude subscription login on this Mac within a minute.",
    fields: ["warmup", ...VERDICT],
  },
  {
    id: "warmup_off",
    kind: "action",
    contract: setWarmup,
    fixed: { enabled: false },
    title: "Turn Session warm-up off",
    description: "No more scheduled warm-up messages.",
    input: none,
    risk: "low",
    fields: ["warmup", ...VERDICT],
  },
  {
    id: "warmup_now",
    kind: "action",
    contract: runWarmup,
    // A warm-up takes seconds per login, and a plugin RPC times out at 30 s.
    fixed: { wait: false },
    title: "Warm up every Claude login now",
    description:
      "Send the warm-up message from every Claude subscription login now. Answers at once with warmup.running true; the warmup read has the results, one per login, a minute later. Refused while one is already running.",
    input: none,
    risk: "outward",
    confirmText: "Warm up now: one tiny Haiku message goes out from every Claude subscription login on this Mac, which starts each login's 5-hour window.",
    fields: ["warmup", ...VERDICT],
  },
];

function jsonSchema(schema: ZodType): Record<string, unknown> {
  // `io: "input"` so a default reads as optional, the way a caller may leave it out.
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

function render(): Capabilities {
  return {
    schema: CAPABILITIES_SCHEMA,
    title: "Caffeine",
    summary:
      "Keeps this Mac awake so agents keep working and the phone can reach it: always, for a while, or while agents run, with the lid closed too. Reads its temperatures, fans, thermal pressure and battery, runs Session warm-up for Claude logins, and can put the Mac to sleep.",
    aliases: [
      "caffeine",
      "keep awake",
      "stay awake",
      "sleep",
      "lid",
      "temperature",
      "fans",
      "heat",
      "battery",
      "warm-up",
      "кофеин",
      "не спать",
      "сон",
      "крышка",
      "температура",
      "вентиляторы",
      "перегрев",
      "батарея",
      "прогрев",
    ],
    operations: OPERATIONS.map((op) => ({
      id: op.id,
      kind: op.kind,
      method: op.contract.name,
      title: op.title,
      description: op.description,
      input: jsonSchema(op.input),
      ...(op.fixed ? { fixed: op.fixed } : {}),
      ...(op.default ? { default: true } : {}),
      output: { fields: op.fields },
      ...(op.risk ? { risk: op.risk, confirm: op.risk === "low" ? ("none" as const) : ("always" as const) } : {}),
      ...(op.confirmText ? { confirmText: op.confirmText } : {}),
      ...(op.kind === "action" ? { outcome: { error: "refused" } } : {}),
    })),
  };
}

let rendered: Capabilities | null = null;

/**
 * Rendered on the first call rather than at load: `contribute()` must not be able to fail
 * because of a schema that will not render. A broken description costs this one method,
 * never the plugin.
 */
export function describeCaffeine(): Capabilities {
  rendered ??= render();
  return rendered;
}
