import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useRef, useState } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import { type FanReading, type Status, THERMAL_LIMITS, type ThermalEvent, type ThermalStatus, preferences } from "../shared/caffeine.shared.ts";
import { type Strings, formatRemaining } from "./i18n.ts";

/**
 * The heat block of the state card, its banner, and the fan popup. The block follows the
 * power section's shape — a heading line with its figure on the right, a thin bar, a line of
 * readings — and its rules: figures in the text's colours, colour only on the bar and the
 * pressure dot, and no state said by colour alone (a word always goes with it).
 */

/** The battery bar runs from here to the fixed limit: below 20 °C there is nothing to see. */
const SCALE_FROM_C = 20;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** "5777" → "5 777". */
const groups = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const clockOf = (iso: string) => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};
/** A delay as it reads: seconds under two minutes, minutes after. */
export const delayLabel = (seconds: number, strings: Strings) => (seconds < 120 ? strings.seconds(seconds) : strings.minutes(seconds / 60));

/** The busiest fan as a share of its own maximum, or null. */
function topPct(fans: readonly FanReading[]): number | null {
  const shares = fans.filter((fan) => fan.max > 0).map((fan) => (fan.rpm / fan.max) * 100);
  return shares.length === 0 ? null : Math.max(...shares);
}

function pressureColour(level: number | null, theme: PluginTheme): string {
  if (level === null) return theme.colors.foregroundMuted;
  if (level === 0) return theme.colors.statusSuccess;
  if (level === 1) return theme.colors.statusWarning;
  return theme.colors.statusDanger;
}

/** The line under the bar, when there is something to say: what fires when, or the cool-down. */
function stateLine(thermal: ThermalStatus, strings: Strings, now: number): { text: string; tone: "danger" | "warning" | "muted" } | null {
  const reason = strings.heatReason(thermal.pendingReason);
  const wait = thermal.firesAt ? strings.seconds(Math.max(0, Math.ceil((Date.parse(thermal.firesAt) - now) / 1000))) : "";
  switch (thermal.state) {
    case "pending":
      return { text: wait ? strings.heatPending(reason, wait) : strings.heatPendingNext(reason), tone: "danger" };
    case "blind":
      return { text: strings.heatBlind(wait || strings.seconds(THERMAL_LIMITS.blindS)), tone: "danger" };
    case "latched":
      if (thermal.cool) return { text: strings.heatCooled, tone: "muted" };
      if (thermal.coolAt) return { text: strings.heatCooling(formatRemaining(Math.max(0, Date.parse(thermal.coolAt) - now), strings)), tone: "warning" };
      return { text: strings.heatCoolingUnknown, tone: "warning" };
    default:
      return null;
  }
}

export function HeatSection({
  status,
  theme,
  strings,
  now,
  onFans,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  now: number;
  onFans(): void;
}) {
  const thermal = status.thermal;
  const level = thermal.pressure;
  const battery = thermal.batteryC;
  const { batteryLimitC: limit, batteryWarmC: warm } = THERMAL_LIMITS;
  const fill = battery === null ? 0 : clamp((battery - SCALE_FROM_C) / (limit - SCALE_FROM_C), 0, 1);
  const fillColour =
    battery === null ? theme.colors.border : battery >= limit ? theme.colors.statusDanger : battery >= warm ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const line = stateLine(thermal, strings, now);
  const toneColour = (tone: "danger" | "warning" | "muted") =>
    tone === "danger" ? theme.colors.statusDanger : tone === "warning" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const tags = [thermal.simulated ? strings.heatSimulated : "", thermal.dryRun ? strings.heatDryRun : ""].filter((tag) => tag !== "");
  const fans = thermal.fans;
  // [] is a Mac without fans: no block. null is fans that could not be read: shown, as "—".
  const showFans = fans === null || fans.length > 0;
  const topRpm = fans && fans.length > 0 ? Math.max(...fans.map((fan) => fan.rpm)) : null;
  const manual = (fans ?? []).some((fan) => fan.manual);
  const warmMark = (level !== null && level >= 2) || (battery !== null && battery >= limit);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{strings.heatTitle}</Text>
          {warmMark ? (
            <Icon name="TriangleAlert" size={13} color={theme.colors.statusDanger} />
          ) : (
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pressureColour(level, theme) }} />
          )}
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
            {level === null ? strings.pressureUnknown : strings.pressureLevel(level)}
            {tags.length > 0 ? <Text style={{ color: theme.colors.foregroundMuted }}>{` · ${tags.join(" · ")}`}</Text> : null}
          </Text>
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
          {`${battery === null ? "—" : Math.round(battery)} / ${limit} °C`}
        </Text>
      </View>

      {/* The battery against its fixed limit; the notch is where "warm" starts. */}
      <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.border, overflow: "hidden" }}>
        <View style={{ width: `${Math.round(fill * 100)}%`, height: 6, backgroundColor: fillColour }} />
        <View
          style={{
            position: "absolute",
            left: `${Math.round(((warm - SCALE_FROM_C) / (limit - SCALE_FROM_C)) * 100)}%`,
            top: 0,
            bottom: 0,
            width: 2,
            backgroundColor: theme.colors.surface1,
          }}
        />
      </View>

      {line ? <Text style={{ color: toneColour(line.tone), fontSize: 12 }}>{line.text}</Text> : null}

      {thermal.cpuC !== null || showFans ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          {thermal.cpuC !== null ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
              {"CPU  "}
              <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{`${thermal.cpuC} °C`}</Text>
            </Text>
          ) : (
            <View />
          )}
          {showFans ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${strings.fanAdjust}: ${topRpm === null ? "—" : strings.rpm(groups(topRpm))}`}
              onPress={onFans}
              hitSlop={8}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Icon name="Fan" size={14} color={theme.colors.foregroundMuted} />
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                {topRpm === null ? "—" : strings.rpm(groups(topRpm))}
              </Text>
              {manual ? <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} /> : null}
              <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Pill({ label, theme, onPress, selected = false, disabled = false }: { label: string; theme: PluginTheme; onPress(): void; selected?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      onPress={disabled ? undefined : onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : "transparent",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** Right under the state line after a trip, until somebody says OK. */
export function HeatEventBanner({ event, theme, strings, busy, onDismiss }: { event: ThermalEvent | null; theme: PluginTheme; strings: Strings; busy: boolean; onDismiss(): void }) {
  if (!event) return null;
  const time = clockOf(event.at);
  const reason = strings.heatReason(event.reason);
  const text = event.dryRun
    ? strings.heatEventDry(time, reason, event.detail)
    : event.slept === false
      ? strings.heatEventFailed(time, reason, event.holders.join(", ") || "?")
      : event.slept === true
        ? strings.heatEventSlept(time, reason, event.detail)
        : strings.heatEventSeen(time, reason, event.detail);
  const colour = event.dryRun ? theme.colors.foregroundMuted : event.slept === false ? theme.colors.statusDanger : theme.colors.statusWarning;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Icon name={event.dryRun ? "FlaskConical" : "TriangleAlert"} size={14} color={colour} />
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 12 }}>{text}</Text>
      <Pill label={strings.heatEventOk} theme={theme} onPress={onDismiss} disabled={busy} />
    </View>
  );
}

/**
 * A slider in plain React Native, which has none: one PanResponder over the track for touch
 * and mouse alike, the value on a grid of `step`, and the − / + buttons beside it for when a
 * drag is awkward. Announced as adjustable, with increment and decrement.
 */
function Slider({
  value,
  min,
  max,
  step,
  marker,
  label,
  theme,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Where the fans are now, as a notch on the track; null for none. */
  marker: number | null;
  label: string;
  theme: PluginTheme;
  onChange(value: number): void;
}) {
  const track = useRef<View>(null);
  const geometry = useRef({ x: 0, width: 1 });
  const latest = useRef({ min, max, step, onChange });
  latest.current = { min, max, step, onChange };
  const pick = (pageX: number) => {
    const { min: low, max: high, step: grid, onChange: change } = latest.current;
    const ratio = clamp((pageX - geometry.current.x) / geometry.current.width, 0, 1);
    change(clamp(Math.round((low + ratio * (high - low)) / grid) * grid, low, high));
  };
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // The sheet or page around it must not take the drag over halfway.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const pageX = event.nativeEvent.pageX;
        track.current?.measure((_x, _y, width, _height, left) => {
          geometry.current = { x: left, width: width || 1 };
          pick(pageX);
        });
      },
      onPanResponderMove: (event) => pick(event.nativeEvent.pageX),
    }),
  ).current;
  const at = (number: number): `${number}%` => `${Math.round(((number - min) / (max - min || 1)) * 100)}%`;
  return (
    <View
      ref={track}
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: `${value} %` }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => onChange(clamp(value + (event.nativeEvent.actionName === "increment" ? step : -step), min, max))}
      style={{ height: 36, justifyContent: "center", flex: 1 }}
    >
      <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.border, overflow: "hidden" }}>
        <View style={{ width: at(value), height: 6, backgroundColor: theme.colors.accent }} />
      </View>
      {marker !== null && marker >= min && marker <= max ? (
        <View pointerEvents="none" style={{ position: "absolute", left: at(marker), top: 8, bottom: 8, width: 2, backgroundColor: theme.colors.foregroundMuted }} />
      ) : null}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: at(value),
          marginLeft: -11,
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: theme.colors.accent,
          borderWidth: 3,
          borderColor: theme.colors.surface1,
        }}
      />
    </View>
  );
}

/**
 * The fan threshold, in a small card over the page (the SDK's Modal opens as a 65 % sheet on
 * a phone, too big for one slider). Each fan against its own maximum; the range starts a
 * little above this machine's fan floor and ends at 95 %; nothing is applied until Save.
 */
export function FanPopup({ status, theme, strings, onClose }: { status: Status; theme: PluginTheme; strings: Strings; onClose(): void }) {
  const prefs = useSettings(preferences);
  const thermal = status.thermal;
  const applied = thermal.settings;
  const [pct, setPct] = useState(applied.fanPct);
  const [delayS, setDelayS] = useState(applied.fanDelayS);
  const fans = thermal.fans ?? [];
  const now = topPct(fans);
  const maxRpm = fans.length > 0 ? Math.max(...fans.map((fan) => fan.max)) : 0;
  const { fanMaxPct, fanStepPct, fanDefaultPct, fanDelaysS } = THERMAL_LIMITS;
  const min = applied.fanMinPct;
  const below = now !== null && pct <= now;
  const changed = pct !== applied.fanPct || delayS !== applied.fanDelayS;
  const ready = prefs.status === "ready" && !prefs.saving;
  const save = () => {
    if (prefs.status !== "ready") return;
    void prefs.save({ ...prefs.values, fanPct: pct, fanDelayS: delayS }, prefs.revision).then((saved) => {
      if (saved) onClose();
    });
  };
  const nudge = (by: number) => setPct((value) => clamp(value + by, min, fanMaxPct));

  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 16 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.fanClose}
        onPress={onClose}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.55)" }}
      />
      <View
        style={{
          width: "100%",
          maxWidth: 380,
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 16,
          padding: 16,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="Fan" size={16} color={theme.colors.accent} />
          <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 16, fontWeight: "700" }}>{strings.fanTitle}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={strings.fanClose} onPress={onClose} hitSlop={10}>
            <Icon name="X" size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>

        {thermal.fans === null ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{strings.fanNoData}</Text>
        ) : (
          <View style={{ gap: 4 }}>
            {fans.map((fan, index) => (
              <View key={index} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{strings.fanLabel(index + 1)}</Text>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontVariant: ["tabular-nums"] }}>
                  {`${groups(fan.rpm)} / ${strings.rpm(groups(fan.max))}`}
                </Text>
              </View>
            ))}
          </View>
        )}
        {fans.some((fan) => fan.manual) ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{strings.fanManual}</Text> : null}

        <View style={{ gap: 2 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{strings.fanThreshold}</Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 28, fontWeight: "700" }}>{`${pct} %`}</Text>
            {maxRpm > 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{`≈ ${strings.rpm(groups((pct / 100) * maxRpm))}`}</Text>
            ) : null}
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Pill label="−" theme={theme} onPress={() => nudge(-fanStepPct)} disabled={pct <= min} />
          <Slider value={pct} min={min} max={fanMaxPct} step={fanStepPct} marker={now} label={strings.fanAdjust} theme={theme} onChange={setPct} />
          <Pill label="+" theme={theme} onPress={() => nudge(fanStepPct)} disabled={pct >= fanMaxPct} />
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: -6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{`${min} %`}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{`${fanMaxPct} %`}</Text>
        </View>
        {below ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{strings.fanBelowCurrent}</Text> : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{strings.fanFor}</Text>
          {fanDelaysS.map((seconds) => (
            <Pill key={seconds} label={delayLabel(seconds, strings)} theme={theme} selected={delayS === seconds} onPress={() => setDelayS(seconds)} />
          ))}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{strings.fanLidOnly}</Text>

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <Pill
            label={strings.fanReset}
            theme={theme}
            onPress={() => {
              setPct(clamp(fanDefaultPct, min, fanMaxPct));
              setDelayS(60);
            }}
          />
          <Pill label={strings.fanSave} theme={theme} selected onPress={save} disabled={!ready || !changed || below} />
        </View>
      </View>
    </View>
  );
}
