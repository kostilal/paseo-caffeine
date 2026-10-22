import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { SLEEP_DELAY_MS, type Battery, type SetInput, type SetOptionsInput, type Status, getStatus, runWarmup, setLid, setMode, setOptions, setWarmup, setupLid, sleepNow } from "../shared/caffeine.shared.ts";
import { type Strings, detectAppLocale, formatRemaining, t } from "./i18n.ts";
import { SILENCE_TIMEOUT_MS, type SleepEvent, type SleepPhase, isSleepInFlight, nextSleepPhase } from "./sleep-phase.ts";

const QUERY_KEY = ["caffeine", "status"] as const;
const TIMER_MINUTES = [30, 60, 120, 180, 480, 720] as const;
type TimerMinutes = (typeof TIMER_MINUTES)[number];

/**
 * The surface fits a phone without scrolling, and what buys the room is the shape rather
 * than the size: Off, On and Sleep now share a row, state and battery share a card, and no section
 * label captions a control that already says what it is. With those, compact only has to
 * be a little tighter than the desktop — shrinking the type as well left half the screen
 * empty. While-agents-work shares a row with the display switch, and Timer keeps one of
 * its own for the six chips that want the width.
 */
const METRICS = {
  compact: { gutter: 16, gap: 14, pad: 16, icon: 44, title: 22, tile: "30%" as const },
  roomy: { gutter: 24, gap: 16, pad: 16, icon: 44, title: 24, tile: "30%" as const },
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
function formatWatts(watts: number): string {
  return `${watts >= 10 ? Math.round(watts) : watts.toFixed(1)} W`;
}

/** Green with room to spare, amber when it is getting thin, red near empty. */
function batteryColour(battery: Battery, theme: PluginTheme): string {
  if (battery.external) return theme.colors.statusSuccess;
  if (battery.percent <= 10) return theme.colors.statusDanger;
  if (battery.percent <= 25) return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

/**
 * The battery as macOS reports it: a filled glyph, the percentage, whether the charger is
 * in, and how long the charge has left — or how long until it is full. The glyph is the
 * progress bar; a second full-width one underneath would say the same thing twice and
 * cost a line the phone does not have.
 */
function BatteryRow({ battery, theme, strings }: { battery: Battery; theme: PluginTheme; strings: Strings }) {
  const colour = batteryColour(battery, theme);
  const eta = battery.minutes === null ? null : formatRemaining(battery.minutes * 60_000, strings);

  let detail: string;
  if (battery.charging) detail = eta ? strings.batteryUntilFull(eta) : strings.batteryNoEstimate;
  else if (battery.charged) detail = strings.batteryCharged;
  else detail = eta ? strings.batteryUntilEmpty(eta) : strings.batteryNoEstimate;

  // On the charger, what it is pulling now sits next to the charge, and what the charger
  // is rated for and how much of it reaches the battery go on a quieter line underneath.
  const intake = battery.external && battery.inputWatts !== null ? formatWatts(battery.inputWatts) : null;
  const flow: string[] = [];
  if (battery.external && battery.adapterWatts !== null) flow.push(strings.wattsAdapter(formatWatts(battery.adapterWatts)));
  if (battery.external && battery.batteryWatts !== null && battery.batteryWatts > 0) {
    flow.push(strings.wattsIntoBattery(formatWatts(battery.batteryWatts)));
  }

  return (
    <View style={{ gap: 6 }}>
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
          {intake ? <Text style={{ color: colour, fontSize: 15, fontWeight: "700" }}>{intake}</Text> : null}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flex: 1, textAlign: "right" }}>
            {`${battery.external ? strings.powerAC : strings.powerBattery} · ${detail}`}
          </Text>
        </View>
      </View>
      {flow.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "right" }}>{flow.join(" · ")}</Text>
      ) : null}
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
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  now: number;
  updatedAgo: number | null;
  pad: number;
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

      {status.battery ? (
        <>
          <View style={{ height: 1, backgroundColor: theme.colors.border }} />
          <BatteryRow battery={status.battery} theme={theme} strings={strings} />
        </>
      ) : null}

      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{`${strings.errorPrefix}: ${status.error}`}</Text>
      ) : null}

      {updatedAgo !== null ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{strings.updated(updatedAgo)}</Text>
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
}: {
  icon: string;
  title: string;
  detail: string;
  selected: boolean;
  theme: PluginTheme;
  onPress?: () => void;
  children?: React.ReactNode;
  /** A share of the row: Off, On and Sleep now sit three across. */
  tile: `${number}%`;
  /** Breathes the glyph while something is in flight; steady when absent. */
  iconPulse?: Animated.Value;
}) {
  const glyph = <Icon name={icon} size={16} color={selected ? theme.colors.accent : theme.colors.foregroundMuted} />;
  const body = (
    <View
      style={{
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: 15,
        gap: 6,
        flexBasis: tile,
        flexGrow: 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {iconPulse ? <Animated.View style={{ opacity: iconPulse }}>{glyph}</Animated.View> : glyph}
        {/* flex so a title too long for the tile wraps inside it instead of over the border. */}
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}>{title}</Text>
      </View>
      {/* No line limit: a clipped "…after the last agent goe…" reads worse than a third line. */}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{detail}</Text>
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

function Chip({ label, selected, theme, onPress }: { label: string; selected: boolean; theme: PluginTheme; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
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
 * The timer's lid switch: with it on, the timer and On also let the lid close, for exactly as
 * long as they last. It is the one control that changes a system setting rather than holding
 * the Mac from inside a process, so it says what it is doing right now. Before the one-time
 * permission is in place it offers that instead, in one press.
 */
function LidSwitch({
  status,
  theme,
  strings,
  now,
  busy,
  onToggle,
  onSetup,
  onResume,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  now: number;
  busy: boolean;
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
  let detail: string;
  if (needsSetup && !lid.on) detail = strings.lidSetup;
  else if (lid.on && !ours) detail = strings.lidOnNoTimer;
  else if (lid.on) detail = lid.forever ? strings.lidOnForever : strings.lidOn(formatRemaining(remainingMs, strings));
  else if (paused) detail = `${pausedReason(lid, strings)} ${strings.lidPaused}`;
  else detail = status.lidClosed ? strings.lidIdle : strings.lidOff;
  const failed = lid.error !== "" && lid.error !== "needs-setup" ? strings.lidFailed(lid.error) : "";
  // When paused the reason is already the detail; a second line would say it twice.
  const endedNote = lid.on || paused ? "" : lid.ended === "heat" ? strings.lidEndedHeat : lid.ended === "battery" ? strings.lidEndedBattery : "";
  return (
    <View style={{ gap: 6, marginTop: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      {/* Presses are ignored while one is in flight: a "turn off" overtaken by a "turn on" is
          exactly the mix-up this switch cannot afford. */}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center", opacity: busy ? 0.6 : 1 }}>
        <Icon name={lid.on ? "LaptopMinimalCheck" : "LaptopMinimal"} size={16} color={lid.on ? theme.colors.accent : theme.colors.foregroundMuted} />
        {/* Before the permission the switch is offered only to turn it off: switching it on
            would do nothing until the permission is there. */}
        {needsSetup ? <Chip label={strings.lidSetupButton} selected={false} theme={theme} onPress={() => (busy ? undefined : onSetup())} /> : null}
        {!needsSetup || status.lidClosed ? (
          <Chip label={strings.lidLabel} selected={status.lidClosed} theme={theme} onPress={() => (busy ? undefined : onToggle(!status.lidClosed))} />
        ) : null}
        {paused ? <Chip label={strings.lidResume} selected={false} theme={theme} onPress={() => (busy ? undefined : onResume())} /> : null}
      </View>
      <Text style={{ color: paused ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
      {endedNote !== "" ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{endedNote}</Text> : null}
      {failed !== "" ? <Text style={{ color: theme.colors.statusDanger ?? theme.colors.foregroundMuted, fontSize: 12 }}>{failed}</Text> : null}
    </View>
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
 * Session warm-up's tile: the hour (half-hour steps), on/off, and a press to warm up now. The
 * detail says when the window will reset, five hours after the hour.
 */
function WarmupCard({
  status,
  theme,
  strings,
  busy,
  onSet,
  onRun,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  busy: boolean;
  onSet(patch: { enabled?: boolean; time?: string }): void;
  onRun(): void;
}) {
  const { warmup } = status;
  const detail = warmup.enabled ? strings.warmupOn(warmup.time, shiftTime(warmup.time, 300)) : strings.warmupOff;
  const results =
    warmup.results.length === 0 ? strings.warmupNone : warmup.results.map((r) => `${r.login} ${r.ok ? "✓" : `✗ ${r.error}`}`).join(" · ");
  const ignoreWhileBusy = (action: () => void) => () => (busy || warmup.running ? undefined : action());
  return (
    <View style={{ flexDirection: "row" }}>
      <ModeCard icon="Sunrise" title={strings.warmupLabel} detail={detail} selected={warmup.enabled} theme={theme} tile="100%">
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap", alignItems: "center", opacity: busy ? 0.6 : 1 }}>
          <Chip label="−" selected={false} theme={theme} onPress={ignoreWhileBusy(() => onSet({ time: shiftTime(warmup.time, -30) }))} />
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", minWidth: 48, textAlign: "center" }}>{warmup.time}</Text>
          <Chip label="+" selected={false} theme={theme} onPress={ignoreWhileBusy(() => onSet({ time: shiftTime(warmup.time, 30) }))} />
          <Chip
            label={warmup.enabled ? strings.warmupDisable : strings.warmupEnable}
            selected={warmup.enabled}
            theme={theme}
            onPress={ignoreWhileBusy(() => onSet({ enabled: !warmup.enabled }))}
          />
          <Chip label={warmup.running ? strings.warmupRunning : strings.warmupNow} selected={false} theme={theme} onPress={ignoreWhileBusy(onRun)} />
        </View>
        {warmup.lastAt !== "" ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{strings.warmupLast(clockOf(warmup.lastAt), results)}</Text>
        ) : null}
      </ModeCard>
    </View>
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
  const queryClient = useQueryClient();

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

  return (
    // Still a ScrollView: the content is meant to fit, but a small enough phone would
    // otherwise cut the switch off with no way to reach it.
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
          <StateCard status={data} theme={theme} strings={strings} now={now} updatedAgo={updatedAgo} pad={m.pad} />

          {compact ? null : (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase" }}>
              {strings.modeLabel}
            </Text>
          )}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: m.gap }}>
            <ModeCard
              icon="Power"
              title={strings.off}
              detail={strings.offDetail}
              selected={data.mode === "off"}
              theme={theme}
              tile={m.tile}
              onPress={() => change.mutate({ mode: "off" })}
            />
            <ModeCard
              icon="Sun"
              title={strings.on}
              detail={data.lidClosed && data.lid.setup !== "needs-setup" ? strings.onDetailLid : strings.onDetail}
              selected={data.mode === "on"}
              theme={theme}
              tile={m.tile}
              onPress={() => change.mutate({ mode: "on" })}
            />
            <ModeCard
              icon={tile.phase === "asleep" ? "MoonStar" : "Moon"}
              title={tile.phase === "asleep" ? strings.sleptLabel : strings.sleepLabel}
              detail={sleepDetailFor(tile.phase, strings)}
              selected={tile.phase !== "idle"}
              theme={theme}
              tile={m.tile}
              iconPulse={tile.pulse}
              onPress={() => sleep.mutate()}
            >
              {isSleepInFlight(tile.phase) ? (
                <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden", marginTop: 4 }}>
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
          </View>

          {/* While agents work and the display share a row: one is a mode, the other a switch
              that rides along with any mode, shown "on" the same way — by the border. A share under half leaves
              room for the gap down to the narrowest phone, so the two never stack. The timer
              below keeps a row of its own for its six chips. A row is what makes a tile's share
              mean a width: ModeCard's flexBasis resolves against its parent's main axis, and the
              content container's runs down the page, so a card left as a direct child there is
              stretched to the full scroll height. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: m.gap }}>
            <ModeCard
              icon="Zap"
              title={strings.auto}
              detail={strings.autoDetail}
              selected={data.mode === "auto"}
              theme={theme}
              tile="45%"
              onPress={() => change.mutate({ mode: "auto" })}
            />
            <ModeCard
              icon={data.keepDisplay ? "Monitor" : "MonitorOff"}
              title={strings.displayLabel}
              detail={strings.displayState(data.keepDisplay)}
              selected={data.keepDisplay}
              theme={theme}
              tile="45%"
              onPress={() => changeOptions.mutate({ keepDisplay: !data.keepDisplay })}
            />
          </View>

          <View style={{ flexDirection: "row" }}>
            <ModeCard icon="Timer" title={strings.timer} detail={strings.timerDetail} selected={data.mode === "timer"} theme={theme} tile="100%">
              <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                {TIMER_MINUTES.map((minutes) => (
                  <Chip
                    key={minutes}
                    label={formatRemaining(minutes * 60_000, strings)}
                    selected={timerMinutes === minutes}
                    theme={theme}
                    onPress={() => change.mutate({ mode: "timer", minutes })}
                  />
                ))}
              </View>
              <LidSwitch
                status={data}
                theme={theme}
                strings={strings}
                now={now}
                busy={changeOptions.isPending || change.isPending || lidSetupRun.isPending || lidResume.isPending}
                onToggle={(lidClosed) => changeOptions.mutate({ lidClosed })}
                onSetup={() => lidSetupRun.mutate()}
                onResume={() => lidResume.mutate()}
              />
            </ModeCard>
          </View>

          <WarmupCard
            status={data}
            theme={theme}
            strings={strings}
            busy={warmupSet.isPending || warmupRun.isPending}
            onSet={(patch) => warmupSet.mutate(patch)}
            onRun={() => warmupRun.mutate()}
          />

          <WakeLink url={data.wakeUrl} theme={theme} strings={strings} />
        </>
      )}
    </ScrollView>
  );
}
