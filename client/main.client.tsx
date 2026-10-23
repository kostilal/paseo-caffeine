import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { SLEEP_DELAY_MS, type Battery, type SetInput, type SetOptionsInput, type Status, dismissThermal, getStatus, preferences, runWarmup, setLid, setMode, setOptions, setWarmup, setupLid, sleepNow } from "../shared/caffeine.shared.ts";
import { FanPopup, HeatEventBanner, HeatSection } from "./heat.tsx";
import { type Strings, detectAppLocale, formatRemaining, t } from "./i18n.ts";
import { SILENCE_TIMEOUT_MS, type SleepEvent, type SleepPhase, isSleepInFlight, nextSleepPhase } from "./sleep-phase.ts";

const QUERY_KEY = ["caffeine", "status"] as const;
/** The daemon reads the Mac every 30 s (TICK_MS); a reading older than three of those is said. */
const STALE_MS = 90_000;
const TIMER_MINUTES = [30, 60, 120, 180, 480, 720] as const;
type TimerMinutes = (typeof TIMER_MINUTES)[number];

/**
 * The surface fits a phone without scrolling, and what buys the room is the shape rather
 * than the size: the modes share a row, state and battery share a card, and no section
 * label captions a control that already says what it is. With those, compact only has to
 * be a little tighter than the desktop — shrinking the type as well left half the screen
 * empty. Off, On, Sleep now and While agents work sit four across, on the phone as narrow
 * tiles a little closer together (see ModeCard's `narrow`). The timer keeps a row of its own
 * for its six chips, a little tighter on the phone so they stay on one line. The display, the
 * lid and Session warm-up share the last row; on the phone warm-up goes under the other two,
 * since a third of the width cannot hold its chips.
 */
const METRICS = {
  compact: { gutter: 16, gap: 14, pad: 16, icon: 44, title: 22, tile: "20%" as const, modeGap: 8, switches: "45%" as const },
  roomy: { gutter: 24, gap: 16, pad: 16, icon: 44, title: 24, tile: "20%" as const, modeGap: 16, switches: "30%" as const },
};

/** Which chip a running timer belongs to: the one whose length is nearest. */
function minutesOf(status: Status, now: number): TimerMinutes {
  const left = (Date.parse(status.until) - now) / 60_000;
  return TIMER_MINUTES.reduce((best, m) => (Math.abs(m - left) < Math.abs(best - left) ? m : best));
}

/** A clock that ticks once a second, so the remaining time moves between refetches. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Card({ theme, pad, children, style }: { theme: PluginTheme; pad: number; children: React.ReactNode; style?: object }) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: pad,
        gap: 12,
        ...style,
      }}
    >
      {children}
    </View>
  );
}

/** Watts as a person reads them off a charger: whole above ten, one decimal below. */
/** Watts without the unit, for "76 / 140 W". */
function wattsNumber(watts: number): string {
  return watts >= 10 ? String(Math.round(watts)) : watts.toFixed(1);
}

function formatWatts(watts: number): string {
  return `${wattsNumber(watts)} W`;
}

/** Green with room to spare, amber when it is getting thin, red near empty. */
function batteryColour(battery: Battery, theme: PluginTheme): string {
  if (battery.external) return theme.colors.statusSuccess;
  if (battery.percent <= 10) return theme.colors.statusDanger;
  if (battery.percent <= 25) return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

/**
 * The battery as macOS reports it: a filled glyph, the percentage, the bolt while it charges,
 * and how long the charge has left — or how long until it is full. The glyph is the progress
 * bar; a second full-width one underneath would say the same thing twice and cost a line the
 * phone does not have. Where the power comes from is the power section's to say.
 */
function BatteryRow({ battery, theme, strings }: { battery: Battery; theme: PluginTheme; strings: Strings }) {
  const colour = batteryColour(battery, theme);
  const eta = battery.minutes === null ? null : formatRemaining(battery.minutes * 60_000, strings);

  let detail: string;
  if (battery.charging) detail = eta ? strings.batteryUntilFull(eta) : strings.batteryNoEstimate;
  else if (battery.charged) detail = strings.batteryCharged;
  else detail = eta ? strings.batteryUntilEmpty(eta) : strings.batteryNoEstimate;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View
          style={{
            width: 64,
            height: 30,
            borderRadius: 8,
            borderWidth: 2,
            borderColor: theme.colors.border,
            padding: 3,
            justifyContent: "center",
          }}
        >
          {/* Never a bare sliver: a one percent charge still shows as something. */}
          <View
            style={{
              width: `${Math.max(4, battery.percent)}%`,
              height: "100%",
              borderRadius: 3,
              backgroundColor: colour,
            }}
          />
        </View>
        <View
          style={{
            width: 3,
            height: 10,
            marginLeft: 1,
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
            backgroundColor: theme.colors.border,
          }}
        />
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "700" }}>{`${battery.percent}%`}</Text>
        {battery.charging ? <Icon name="Zap" size={15} color={colour} /> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flex: 1, textAlign: "right" }}>{detail}</Text>
      </View>
    </View>
  );
}

/**
 * Where the power comes from and where it goes, the way Wattage Connected shows it. On the
 * charger, a bar as long as the charger's rating: what goes into the battery, what the Mac
 * itself takes (the draw less the battery's share), and what the charger has left, a 2 px gap
 * of the card apart; the same two figures in a column underneath, lined up. The figures wear
 * the text's colours; only the bar and the dots beside them carry the segments'. Off the
 * charger, what the Mac takes from the battery.
 */
function PowerSection({ battery, theme, strings }: { battery: Battery; theme: PluginTheme; strings: Strings }) {
  const rated = battery.external ? battery.adapterWatts : null;
  const input = battery.external ? battery.inputWatts : null;
  const intoBattery = battery.external && battery.batteryWatts !== null && battery.batteryWatts > 0 ? battery.batteryWatts : 0;
  // Never below nothing: the two readings are not taken at the same instant.
  const mac = input === null ? null : Math.max(0, input - intoBattery);
  const draining = !battery.external && battery.batteryWatts !== null && battery.batteryWatts < 0 ? -battery.batteryWatts : null;

  let total = "";
  if (input !== null && rated !== null) total = `${wattsNumber(input)} / ${formatWatts(rated)}`;
  else if (rated !== null) total = strings.wattsAdapter(formatWatts(rated));
  else if (input !== null) total = formatWatts(input);
  else if (draining !== null) total = strings.powerMacDraws(formatWatts(draining));

  const rows = [
    { key: "battery", label: strings.powerIntoBattery, watts: intoBattery, colour: theme.colors.statusSuccess },
    { key: "mac", label: strings.powerMac, watts: mac ?? 0, colour: theme.colors.foregroundMuted },
  ].filter((row) => row.watts > 0);
  // A draw over the rating fills the bar and no more.
  const used = intoBattery + (mac ?? 0);
  const spare = rated !== null && mac !== null ? Math.max(0, rated - used) : null;
  const segments = spare === null ? [] : [...rows, { key: "spare", watts: spare, colour: theme.colors.border }].filter((s) => s.watts > 0);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{battery.external ? strings.powerAC : strings.powerBattery}</Text>
        {total ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, fontVariant: ["tabular-nums"] }}>{total}</Text> : null}
      </View>
      {segments.length > 0 ? (
        <View style={{ flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}>
          {segments.map((segment) => (
            <View key={segment.key} style={{ flexGrow: segment.watts, flexBasis: 0, backgroundColor: segment.colour }} />
          ))}
        </View>
      ) : null}
      {rows.map((row) => (
        <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: row.colour }} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flex: 1 }}>{row.label}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatWatts(row.watts)}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * State and battery in one card: what the Mac is doing, and what it is running on. They
 * were two cards, which cost a border, a set of paddings and a gap for no added meaning.
 */
function StateCard({
  status,
  theme,
  strings,
  now,
  updatedAgo,
  pad,
  dismissing,
  onDismiss,
  onFans,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  now: number;
  updatedAgo: number | null;
  pad: number;
  dismissing: boolean;
  onDismiss(): void;
  onFans(): void;
}) {
  const awake = status.active;
  const colour = awake ? theme.colors.statusSuccess : theme.colors.foregroundMuted;

  let detail = "";
  let progress: number | null = null;
  if (status.mode === "timer") {
    const remaining = Date.parse(status.until) - now;
    detail = strings.remaining(formatRemaining(remaining, strings));
    progress = Math.min(1, Math.max(0, remaining / (minutesOf(status, now) * 60_000)));
  } else if (status.mode === "auto") {
    detail = status.busy ? strings.agentsRunning(status.agents) : status.tickAt ? strings.agentsIdle : strings.agentsWaiting;
  } else if (status.mode === "on") {
    detail = strings.untilOff;
  }

  return (
    <Card theme={theme} pad={pad}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colour }} />
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700", letterSpacing: 1 }}>
            {awake ? strings.stateAwake : strings.stateAsleep}
          </Text>
        </View>
        {detail ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1, textAlign: "right" }}>
            {detail}
          </Text>
        ) : null}
      </View>

      {progress !== null ? (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
          <View style={{ width: `${Math.round(progress * 100)}%`, height: 4, backgroundColor: theme.colors.accent }} />
        </View>
      ) : null}

      <HeatEventBanner event={status.thermal.event} theme={theme} strings={strings} busy={dismissing} onDismiss={onDismiss} />

      {/* How old the reading is matters only once it is old: a fresh one goes unsaid. */}
      {updatedAgo !== null && updatedAgo * 1000 > STALE_MS ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{strings.updated(formatRemaining(updatedAgo * 1000, strings))}</Text>
      ) : null}

      {status.battery ? (
        <>
          <View style={{ height: 1, backgroundColor: theme.colors.border }} />
          <BatteryRow battery={status.battery} theme={theme} strings={strings} />
          <View style={{ height: 1, backgroundColor: theme.colors.border }} />
          <PowerSection battery={status.battery} theme={theme} strings={strings} />
        </>
      ) : null}

      <View style={{ height: 1, backgroundColor: theme.colors.border }} />
      <HeatSection status={status} theme={theme} strings={strings} now={now} onFans={onFans} />

      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{`${strings.errorPrefix}: ${status.error}`}</Text>
      ) : null}
    </Card>
  );
}

function ModeCard({
  icon,
  title,
  detail,
  selected,
  theme,
  onPress,
  children,
  tile,
  iconPulse,
  warn,
  narrow,
}: {
  icon: string;
  title: string;
  detail: string;
  selected: boolean;
  theme: PluginTheme;
  onPress?: () => void;
  children?: React.ReactNode;
  /** A share of the row: Off, On, Sleep now and While agents work sit four across. */
  tile: `${number}%`;
  /** Breathes the glyph while something is in flight; steady when absent. */
  iconPulse?: Animated.Value;
  /** The detail is a warning, said in the warning colour. */
  warn?: boolean;
  /** A quarter of a phone: the glyph over the title, tighter sides and no detail, since that
   *  width holds neither the two side by side nor a sentence. */
  narrow?: boolean;
}) {
  const glyph = <Icon name={icon} size={16} color={selected ? theme.colors.accent : theme.colors.foregroundMuted} />;
  const mark = iconPulse ? <Animated.View style={{ opacity: iconPulse }}>{glyph}</Animated.View> : glyph;
  const body = (
    <View
      style={{
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: narrow ? 8 : 15,
        paddingVertical: narrow ? 12 : 15,
        gap: 6,
        flexBasis: tile,
        flexGrow: 1,
        ...(narrow ? { alignItems: "center" as const, justifyContent: "center" as const } : null),
      }}
    >
      {narrow ? (
        <>
          {mark}
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", textAlign: "center" }}>{title}</Text>
        </>
      ) : (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {mark}
            {/* flex so a title too long for the tile wraps inside it instead of over the border. */}
            <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}>{title}</Text>
          </View>
          {/* No line limit: a clipped "…after the last agent goe…" reads worse than a third line. */}
          <Text style={{ color: warn ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 13 }}>{detail}</Text>
        </>
      )}
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={{ flexBasis: tile, flexGrow: 1 }}>
      {body}
    </Pressable>
  );
}

function Chip({
  label,
  selected,
  theme,
  onPress,
  dense,
}: {
  label: string;
  selected: boolean;
  theme: PluginTheme;
  onPress(): void;
  /** Tighter sides, so the timer's six fit one line of a phone. */
  dense?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: dense ? 8 : 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : "transparent",
      }}
    >
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** Which sentence the tile is telling right now. */
function sleepDetailFor(phase: SleepPhase, strings: Strings): string {
  switch (phase) {
    case "asking":
      return strings.sleepAsking;
    case "going":
      return strings.sleepGoing;
    case "asleep":
      return strings.sleepAsleep;
    case "idle":
      return strings.sleepDetail;
  }
}

/**
 * The Sleep tile's little life: which phase it is in, and the two values that show it.
 *
 * The phases come from the status poll rather than from the mutation, because the
 * mutation cannot report the thing that matters. `pmset sleepnow` suspends the Mac a
 * second after the reply goes out, and a suspended Mac does not send a second message
 * saying so — it simply stops answering. So an answer means "still here", a failed poll
 * means "gone", and the tile is honest about which of those it has seen.
 */
function useSleepTile(poll: { dataUpdatedAt: number; errorUpdatedAt: number; isError: boolean }) {
  const [phase, setPhase] = useState<SleepPhase>("idle");
  const fire = useCallback((event: SleepEvent) => setPhase((current) => nextSleepPhase(current, event)), []);

  const { dataUpdatedAt, errorUpdatedAt, isError } = poll;
  useEffect(() => {
    if (dataUpdatedAt) fire({ type: "answer" });
  }, [dataUpdatedAt, fire]);
  useEffect(() => {
    if (isError) fire({ type: "silence" });
  }, [isError, errorUpdatedAt, fire]);

  // A Mac that answers all the way through plainly did not go under; the tile lets go
  // rather than glowing at somebody for ever.
  useEffect(() => {
    if (phase !== "going") return;
    const timer = setTimeout(() => fire({ type: "timeout" }), SILENCE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, fire]);

  const pulse = useRef(new Animated.Value(1)).current;
  const countdown = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isSleepInFlight(phase)) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 550, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 550, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [phase, pulse]);

  useEffect(() => {
    // `asking` gets a stub rather than a crawl: how long a request takes is the
    // network's business, and a bar that guesses would be inventing progress.
    if (phase === "asking") {
      countdown.setValue(0.12);
      return;
    }
    if (phase !== "going") {
      countdown.setValue(0);
      return;
    }
    // From here the length is known to the millisecond — the daemon waits exactly this
    // long before calling pmset — so the bar runs out as the Mac does.
    countdown.setValue(0.12);
    const run = Animated.timing(countdown, { toValue: 1, duration: SLEEP_DELAY_MS, useNativeDriver: false });
    run.start();
    return () => run.stop();
  }, [phase, countdown]);

  return { phase, fire, pulse, countdown };
}

/**
 * The link that wakes this Mac, and the one control on the page meant to be used when
 * the page itself is unreachable. So it is shown as text rather than as a button: the
 * point is to copy it once — into a shortcut, a bookmark, whatever the phone offers —
 * and press it months later, from a phone that cannot see Paseo because the Mac it runs
 * on is asleep.
 *
 * Pressing it here still opens it, which is how you check the anchor answers at all.
 * The address is the Mac's own on the local network, so the link only carries from
 * inside the house or through the VPN that puts you there.
 */
/** Who turned lid mode off, in words; a reason this client does not know reads as plain "off". */
function pausedReason(lid: Status["lid"], strings: Strings): string {
  if (lid.ended === "battery") return strings.lidEndedBattery;
  if (lid.ended === "heat") return strings.lidEndedHeat;
  if (lid.stopped === "sleep") return strings.lidStoppedSleep;
  if (lid.stopped === "off") return strings.lidStoppedOff;
  if (lid.stopped === "manual") return strings.lidStoppedManual;
  return strings.lidStoppedUnknown;
}

/**
 * The lid switch, a tile beside While agents work and the display: with it on, the timer and
 * On also let the lid close, for exactly as long as they last. It is the one control that
 * changes a system setting rather than holding the Mac from inside a process, so it says what
 * it is doing right now. Before the one-time permission is in place a press asks for that
 * instead, and the switch comes on once it is given.
 */
function LidCard({
  status,
  theme,
  strings,
  now,
  busy,
  tile,
  timerShown,
  onToggle,
  onSetup,
  onResume,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  now: number;
  busy: boolean;
  tile: `${number}%`;
  /** Whether the page offers the timer, so the switch does not point at a row that is not there. */
  timerShown: boolean;
  onToggle(lidClosed: boolean): void;
  onSetup(): void;
  onResume(): void;
}) {
  const { lid } = status;
  const needsSetup = lid.setup === "needs-setup";
  const ours = lid.forever || lid.until !== "";
  const remainingMs = lid.until === "" ? 0 : Math.max(0, Date.parse(lid.until) - now);
  // The switch is on and a timer or On is running, yet lid mode is off: Sleep now, the header,
  // a low battery or heat turned it off, and nothing turns it back on by itself. Said plainly,
  // with a way back, because a closed lid now sleeps the Mac.
  const paused = !needsSetup && !lid.on && status.lidClosed && (status.mode === "timer" || status.mode === "on");
  // A heat trip that has not cooled down: lid mode stays off, and says until when.
  const latch = status.thermal.latch;
  const cooling = latch !== null && !status.thermal.cool;
  const coolLeft = status.thermal.coolAt ? formatRemaining(Math.max(0, Date.parse(status.thermal.coolAt) - now), strings) : "";
  let detail: string;
  if (latch && !lid.on) detail = cooling ? (coolLeft ? strings.lidCooling(coolLeft) : strings.heatCoolingUnknown) : strings.lidCooled;
  else if (needsSetup && !lid.on) detail = strings.lidSetup;
  else if (lid.on && !ours) detail = strings.lidOnNoTimer;
  else if (lid.on) detail = lid.forever ? strings.lidOnForever : strings.lidOn(formatRemaining(remainingMs, strings));
  else if (paused) detail = `${pausedReason(lid, strings)} · ${strings.lidPaused}`;
  else detail = status.lidClosed ? (timerShown ? strings.lidIdle : strings.lidIdleOn) : strings.lidOff;
  const failed =
    lid.error === "cooling" ? (cooling ? "" : strings.lidCoolingError) : lid.error !== "" && lid.error !== "needs-setup" ? strings.lidFailed(lid.error) : "";
  // When paused the reason is already the detail; a second line would say it twice.
  const endedNote = lid.on || paused ? "" : lid.ended === "heat" ? strings.lidEndedHeat : lid.ended === "battery" ? strings.lidEndedBattery : "";
  return (
    <ModeCard
      icon={lid.on ? "LaptopMinimalCheck" : "LaptopMinimal"}
      title={strings.lidLabel}
      detail={detail}
      selected={status.lidClosed}
      theme={theme}
      tile={tile}
      warn={paused}
      // Presses are ignored while one is in flight: a "turn off" overtaken by a "turn on" is
      // exactly the mix-up this switch cannot afford. Before the permission a press asks for
      // it, unless the switch is already on, when it turns the switch off: on, it would do
      // nothing until the permission is there.
      onPress={() => (busy ? undefined : needsSetup && !status.lidClosed ? onSetup() : onToggle(!status.lidClosed))}
    >
      {paused && !cooling ? (
        <View style={{ flexDirection: "row", marginTop: 4, opacity: busy ? 0.6 : 1 }}>
          <Chip label={strings.lidResume} selected={false} theme={theme} onPress={() => (busy ? undefined : onResume())} />
        </View>
      ) : null}
      {endedNote !== "" ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{endedNote}</Text> : null}
      {failed !== "" ? <Text style={{ color: theme.colors.statusDanger ?? theme.colors.foregroundMuted, fontSize: 12 }}>{failed}</Text> : null}
    </ModeCard>
  );
}

/** "HH:MM" moved by `minutes`, wrapping round midnight. */
function shiftTime(time: string, minutes: number): string {
  const [hours, mins] = time.split(":").map(Number);
  const total = ((((hours ?? 0) * 60 + (mins ?? 0) + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** A local clock time, "HH:MM", for an RFC 3339 instant. */
function clockOf(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * Session warm-up's tile: a press on it switches it on and off, − and + move the hour
 * (half-hour steps), and Warm up now runs it at once. The detail says when the window will
 * reset, five hours after the hour.
 */
function WarmupCard({
  status,
  theme,
  strings,
  busy,
  tile,
  onSet,
  onRun,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  busy: boolean;
  tile: `${number}%`;
  onSet(patch: { enabled?: boolean; time?: string }): void;
  onRun(): void;
}) {
  const { warmup } = status;
  const detail = warmup.enabled ? strings.warmupOn(shiftTime(warmup.time, 300)) : strings.warmupOff;
  // A tick when every login warmed up; otherwise only the ones that failed, or that there were none.
  const failed = warmup.results.filter((r) => !r.ok);
  const at = clockOf(warmup.lastAt);
  const last =
    warmup.results.length === 0
      ? strings.warmupLast(at, strings.warmupNone)
      : failed.length === 0
        ? strings.warmupLastOk(at)
        : strings.warmupLast(at, failed.map((r) => `${r.login} ✗ ${r.error}`).join(" · "));
  const ignoreWhileBusy = (action: () => void) => () => (busy || warmup.running ? undefined : action());
  return (
    <ModeCard
      icon="Sunrise"
      title={strings.warmupLabel}
      detail={detail}
      selected={warmup.enabled}
      theme={theme}
      tile={tile}
      onPress={ignoreWhileBusy(() => onSet({ enabled: !warmup.enabled }))}
    >
      <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap", alignItems: "center", opacity: busy ? 0.6 : 1 }}>
        <Chip label="−" selected={false} theme={theme} onPress={ignoreWhileBusy(() => onSet({ time: shiftTime(warmup.time, -30) }))} />
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", minWidth: 48, textAlign: "center" }}>{warmup.time}</Text>
        <Chip label="+" selected={false} theme={theme} onPress={ignoreWhileBusy(() => onSet({ time: shiftTime(warmup.time, 30) }))} />
        <Chip label={warmup.running ? strings.warmupRunning : strings.warmupNow} selected={false} theme={theme} onPress={ignoreWhileBusy(onRun)} />
      </View>
      {warmup.lastAt !== "" ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{last}</Text> : null}
    </ModeCard>
  );
}

function WakeLink({ url, theme, strings }: { url: string; theme: PluginTheme; strings: Strings }) {
  if (!url) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>{strings.wakeMissing}</Text>;
  }
  return (
    <View style={{ alignItems: "center", gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{strings.wakeHint}</Text>
      <Text
        selectable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(url).catch(() => undefined)}
        style={{ color: theme.colors.accent, fontSize: 13 }}
      >
        {url}
      </Text>
    </View>
  );
}

export function CaffeineSurface({ theme, layout }: PluginSurfaceProps) {
  const strings = t(detectAppLocale());
  const now = useNow();
  const fetchStatus = useRpc(getStatus);
  const applyMode = useRpc(setMode);
  const applyOptions = useRpc(setOptions);
  const askSleep = useRpc(sleepNow);
  const askWarmup = useRpc(setWarmup);
  const askWarmupNow = useRpc(runWarmup);
  const askLidSetup = useRpc(setupLid);
  const askLid = useRpc(setLid);
  const askDismiss = useRpc(dismissThermal);
  const [fanOpen, setFanOpen] = useState(false);
  const queryClient = useQueryClient();
  // The timer and Session warm-up are on the page only when Settings says so. Hidden until the
  // answer is in, so a row switched off does not flash up first; a host that cannot answer (no
  // plugin settings there) shows both, since nothing there could ever bring them back.
  const prefs = useSettings(preferences);
  const showTimer = prefs.status === "ready" ? prefs.values.timer : prefs.status !== "loading";
  const showWarmup = prefs.status === "ready" ? prefs.values.warmup : prefs.status !== "loading";

  const { data, isLoading, isError, dataUpdatedAt, errorUpdatedAt } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchStatus({}),
    // Five seconds: the agent count and the tick time are read by a person glancing
    // at a screen; the remaining time itself ticks locally every second.
    refetchInterval: 5_000,
  });

  const change = useMutation({
    mutationFn: (input: SetInput) => applyMode(input),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const changeOptions = useMutation({
    mutationFn: (patch: SetOptionsInput) => applyOptions(patch),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const warmupSet = useMutation({
    mutationFn: (patch: { enabled?: boolean; time?: string }) => askWarmup(patch),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  // Answers once every login has been warmed up: seconds per account.
  const warmupRun = useMutation({
    mutationFn: () => askWarmupNow({}),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const lidResume = useMutation({
    mutationFn: () => askLid({ lid: "on" }),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  // The password dialog shows on the Mac and waits for a person, so this one can take minutes.
  const lidSetupRun = useMutation({
    mutationFn: () => askLidSetup({}),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  // No optimistic status and nothing written back: the answer describes a Mac that is
  // about to suspend, and what happens next is told by the poll going quiet rather than
  // by anything this request returns.
  const tile = useSleepTile({ dataUpdatedAt, errorUpdatedAt, isError });
  const sleep = useMutation({
    mutationFn: () => askSleep({}),
    onMutate: () => tile.fire({ type: "press" }),
    onSuccess: () => tile.fire({ type: "answered" }),
    onError: () => tile.fire({ type: "refused" }),
  });

  const compact = layout.compact;
  const m = compact ? METRICS.compact : METRICS.roomy;
  const timerMinutes = data?.mode === "timer" ? minutesOf(data, now) : null;
  const updatedAgo = data?.tickAt ? Math.max(0, Math.round((now - Date.parse(data.tickAt)) / 1000)) : null;

  const dismiss = useMutation({
    mutationFn: () => askDismiss({}),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  return (
    // The fan popup sits over the page, outside the scroll, so it stays put while the page
    // under it does not move.
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
    {/* Still a ScrollView: the content is meant to fit, but a small enough phone would
        otherwise cut the switch off with no way to reach it. */}
    <ScrollView
      style={{ backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: m.gutter, gap: m.gap, maxWidth: 760, width: "100%", alignSelf: "center" }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <View
          style={{
            width: m.icon,
            height: m.icon,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Icon name="Coffee" size={22} color={theme.colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: m.title, fontWeight: "700" }}>{strings.title}</Text>
          {/* The phone gets the line that carries the meaning, not the one that repeats the title. */}
          {compact ? null : <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{strings.tagline}</Text>}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
            {strings.taglineDetail(data?.keepDisplay ?? false)}
          </Text>
        </View>
      </View>

      {isLoading || !data ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <>
          <StateCard
            status={data}
            theme={theme}
            strings={strings}
            now={now}
            updatedAgo={updatedAgo}
            pad={m.pad}
            dismissing={dismiss.isPending}
            onDismiss={() => dismiss.mutate()}
            onFans={() => setFanOpen(true)}
          />

          {compact ? null : (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase" }}>
              {strings.modeLabel}
            </Text>
          )}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: m.modeGap }}>
            <ModeCard
              icon="Power"
              title={strings.off}
              detail={strings.offDetail}
              selected={data.mode === "off"}
              theme={theme}
              tile={m.tile}
              narrow={compact}
              onPress={() => change.mutate({ mode: "off" })}
            />
            <ModeCard
              icon="Sun"
              title={strings.on}
              detail={data.lidClosed && data.lid.setup !== "needs-setup" ? strings.onDetailLid : strings.onDetail}
              selected={data.mode === "on"}
              theme={theme}
              tile={m.tile}
              narrow={compact}
              onPress={() => change.mutate({ mode: "on" })}
            />
            <ModeCard
              icon={tile.phase === "asleep" ? "MoonStar" : "Moon"}
              title={tile.phase === "asleep" ? strings.sleptLabel : strings.sleepLabel}
              detail={sleepDetailFor(tile.phase, strings)}
              selected={tile.phase !== "idle"}
              theme={theme}
              tile={m.tile}
              narrow={compact}
              iconPulse={tile.pulse}
              onPress={() => sleep.mutate()}
            >
              {/* Stretched: a narrow tile centres its content, which would give the bar no width. */}
              {isSleepInFlight(tile.phase) ? (
                <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden", marginTop: 4, alignSelf: "stretch" }}>
                  <Animated.View
                    style={{
                      height: 3,
                      backgroundColor: theme.colors.accent,
                      width: tile.countdown.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
                    }}
                  />
                </View>
              ) : null}
            </ModeCard>
            <ModeCard
              icon="Zap"
              title={strings.auto}
              detail={strings.autoDetail}
              selected={data.mode === "auto"}
              theme={theme}
              tile={m.tile}
              narrow={compact}
              onPress={() => change.mutate({ mode: "auto" })}
            />
          </View>

          {/* The timer, right under the modes, keeps a row of its own for its six chips. A row is
              what makes a tile's share mean a width: ModeCard's flexBasis resolves against its
              parent's main axis, and the content container's runs down the page, so a card left
              as a direct child there is stretched to the full scroll height. */}
          {showTimer ? (
          <View style={{ flexDirection: "row" }}>
            <ModeCard icon="Timer" title={strings.timer} detail={strings.timerDetail} selected={data.mode === "timer"} theme={theme} tile="100%">
              <View style={{ flexDirection: "row", gap: compact ? 6 : 8, marginTop: 4, flexWrap: "wrap" }}>
                {TIMER_MINUTES.map((minutes) => (
                  <Chip
                    key={minutes}
                    label={formatRemaining(minutes * 60_000, strings)}
                    selected={timerMinutes === minutes}
                    theme={theme}
                    dense={compact}
                    onPress={() => change.mutate({ mode: "timer", minutes })}
                  />
                ))}
              </View>
            </ModeCard>
          </View>
          ) : null}

          {/* The display, the lid and Session warm-up share a row: switches that ride along with
              the modes, shown "on" the same way as a mode — by the border. On the phone warm-up
              wraps under the other two, at the full width. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: m.gap }}>
            <ModeCard
              icon={data.keepDisplay ? "Monitor" : "MonitorOff"}
              title={strings.displayLabel}
              detail={strings.displayState(data.keepDisplay)}
              selected={data.keepDisplay}
              theme={theme}
              tile={m.switches}
              onPress={() => changeOptions.mutate({ keepDisplay: !data.keepDisplay })}
            />
            <LidCard
              status={data}
              theme={theme}
              strings={strings}
              now={now}
              busy={changeOptions.isPending || change.isPending || lidSetupRun.isPending || lidResume.isPending}
              tile={m.switches}
              timerShown={showTimer}
              onToggle={(lidClosed) => changeOptions.mutate({ lidClosed })}
              onSetup={() => lidSetupRun.mutate()}
              onResume={() => lidResume.mutate()}
            />
            {showWarmup ? (
              <WarmupCard
                status={data}
                theme={theme}
                strings={strings}
                busy={warmupSet.isPending || warmupRun.isPending}
                tile={m.switches}
                onSet={(patch) => warmupSet.mutate(patch)}
                onRun={() => warmupRun.mutate()}
              />
            ) : null}
          </View>

          <WakeLink url={data.wakeUrl} theme={theme} strings={strings} />
        </>
      )}
    </ScrollView>
    {fanOpen && data ? <FanPopup status={data} theme={theme} strings={strings} onClose={() => setFanOpen(false)} /> : null}
    </View>
  );
}
