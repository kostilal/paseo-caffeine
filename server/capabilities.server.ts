import { defineRpc, type PluginRpcContract } from "@getpaseo/plugin";
import { type ZodType, z } from "zod";
import { getStatus, setMode, setOptions, setOptionsInput, sleepNow, timerMinutes } from "../shared/caffeine.shared.ts";

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
   * Actions only. `low` is local and undone with one more call. `disruptive` interrupts running
   * work or cuts the Mac off from ChatGPT, and is always confirmed first.
   */
  risk: z.enum(["low", "outward", "disruptive", "destructive"]).optional(),
  confirm: z.enum(["none", "always"]).optional(),
  /** What the user hears before a confirmed action runs. */
  confirmText: z.string().optional(),
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
  fields?: string[];
  risk?: "low" | "disruptive";
  confirmText?: string;
}

const none = z.object({});

// The status keeps everything a person asks about and drops the plumbing: the wake link is
// a LAN address with no meaning off the home network, and tickAt is the controller's clock.
// Every action answers with the same status, so it is trimmed the same way.
const STATUS_FIELDS = ["mode", "until", "active", "busy", "agents", "keepDisplay", "lidClosed", "battery", "error"];

export const OPERATIONS: CaffeineOperation[] = [
  {
    id: "status",
    kind: "read",
    contract: getStatus,
    default: true,
    title: "Keep-awake status",
    description:
      "Whether the Mac is held awake now (active), the mode: off, on, timer (until the time in `until`) or auto (while agents work); busy = an agent worked in the last few minutes; how many agents run now; whether the display is held too; whether the timer and On also let the lid close (lidClosed); and the battery, with the watts on the charger (adapterWatts = what the charger is rated for, inputWatts = what the Mac draws from it now, batteryWatts = into the battery when positive, out of it when negative).",
    input: none,
    fields: STATUS_FIELDS,
  },
  {
    id: "keep_awake",
    kind: "action",
    contract: setMode,
    fixed: { mode: "on" },
    title: "Keep the Mac awake",
    description: "Keep the Mac awake until told otherwise. Survives a restart of Paseo.",
    input: none,
    risk: "low",
    fields: STATUS_FIELDS,
  },
  {
    id: "keep_awake_for",
    kind: "action",
    contract: setMode,
    fixed: { mode: "timer" },
    title: "Keep the Mac awake for a while",
    description: "Keep the Mac awake for a number of minutes, then let it sleep again. Only 30, 60, 120, 180, 480 or 720 minutes.",
    input: z.object({ minutes: timerMinutes }),
    risk: "low",
    fields: STATUS_FIELDS,
  },
  {
    id: "auto",
    kind: "action",
    contract: setMode,
    fixed: { mode: "auto" },
    title: "Keep the Mac awake while agents work",
    description: "Keep the Mac awake while any agent is running, and for three minutes after the last one goes quiet.",
    input: none,
    risk: "low",
    fields: STATUS_FIELDS,
  },
  {
    id: "allow_sleep",
    kind: "action",
    contract: setMode,
    fixed: { mode: "off" },
    title: "Let the Mac sleep again",
    description: "Stop holding the Mac awake; it sleeps when idle, as it normally would.",
    input: none,
    // Not low: an idle Mac that falls asleep pauses its agents and drops off the relay.
    risk: "disruptive",
    fields: STATUS_FIELDS,
    confirmText:
      "Stop keeping the Mac awake: it may fall asleep when idle, which pauses the agents, and ChatGPT cannot reach it while it sleeps.",
  },
  {
    id: "keep_display",
    kind: "action",
    contract: setOptions,
    title: "Keep the display on too",
    description: "true holds the display awake along with the system; false lets the display sleep as usual.",
    input: setOptionsInput.pick({ keepDisplay: true }).required(),
    risk: "low",
    fields: STATUS_FIELDS,
  },
  {
    id: "lid_closed",
    kind: "action",
    contract: setOptions,
    title: "Let the lid close under the timer and On",
    description:
      "true: while a timer or On runs, the Mac keeps running with the lid closed too, for as long as they last (it still stops on a battery below 20% or when the Mac runs hot); false: closing the lid sleeps the Mac as usual. Needs a one-time permission set up on the Mac.",
    input: setOptionsInput.pick({ lidClosed: true }).required(),
    risk: "low",
    fields: STATUS_FIELDS,
  },
  {
    id: "sleep_now",
    kind: "action",
    contract: sleepNow,
    title: "Put the Mac to sleep now",
    description: "Send the Mac to sleep a second after answering, from wherever the user is.",
    input: none,
    risk: "disruptive",
    fields: STATUS_FIELDS,
    confirmText:
      "Put the Mac to sleep now: the agents pause, and ChatGPT cannot reach the Mac until it is woken, for example with the wake link on the home network.",
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
    summary: "Keeps this Mac awake so agents keep working and the phone can reach it: always, for a while, or while agents run. Can also put the Mac to sleep.",
    aliases: ["caffeine", "keep awake", "stay awake", "sleep", "кофеин", "не спать", "сон"],
    operations: OPERATIONS.map((op) => ({
      id: op.id,
      kind: op.kind,
      method: op.contract.name,
      title: op.title,
      description: op.description,
      input: jsonSchema(op.input),
      ...(op.fixed ? { fixed: op.fixed } : {}),
      ...(op.default ? { default: true } : {}),
      ...(op.fields ? { output: { fields: op.fields } } : {}),
      ...(op.risk ? { risk: op.risk, confirm: op.risk === "low" ? ("none" as const) : ("always" as const) } : {}),
      ...(op.confirmText ? { confirmText: op.confirmText } : {}),
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
