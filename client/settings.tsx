import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { type Preferences, THERMAL_LIMITS, defaultPreferences, preferences, setWarmup } from "../shared/caffeine.shared.ts";
import { delayLabel } from "./heat.tsx";
import { detectAppLocale, t } from "./i18n.ts";

/** The delays a pressure level offers, and its default (server/thermal.ts normalizes the same way). */
const delaysFor = (level: Preferences["thermalPressure"]) => (level === "moderate" ? THERMAL_LIMITS.moderateDelaysS : THERMAL_LIMITS.heavyDelaysS);
const defaultDelay = (level: Preferences["thermalPressure"]) => (level === "moderate" ? 300 : 60);

/**
 * Settings → Plugins → Caffeine → Settings: whether the page offers the timer and Session
 * warm-up at all (both hidden until asked for), and the heat guard's sensitivity. The fixed parts of the guard are listed, not offered: the
 * battery limit, trapping at once, and no readings with the lid closed. The fan threshold
 * lives in the popup on the page, by the fan reading it is about.
 */
export function CaffeineSettings() {
  const strings = t(detectAppLocale());
  const state = useSettings(preferences);
  const askWarmup = useRpc(setWarmup);
  const values = state.status === "ready" ? state.values : defaultPreferences;
  const busy = state.status !== "ready" || state.saving;
  const save = (patch: Partial<Preferences>) => {
    if (state.status === "ready") void state.save({ ...state.values, ...patch }, state.revision);
  };
  const level = values.thermalPressure;
  const delays = delaysFor(level);
  const delay = (delays as readonly number[]).includes(values.thermalDelayS) ? values.thermalDelayS : defaultDelay(level);
  const cooldown = (THERMAL_LIMITS.cooldownsMin as readonly number[]).includes(values.thermalCooldownMin) ? values.thermalCooldownMin : 5;
  return (
    <View style={{ gap: 12 }}>
      <SettingsSection title={strings.title}>
        <SettingsCard>
          <SettingsSwitch
            label={strings.timer}
            hint={strings.settingsTimerHint}
            value={values.timer}
            disabled={busy}
            onValueChange={(timer) => save({ timer })}
          />
          <SettingsSwitch
            label={strings.warmupLabel}
            hint={strings.settingsWarmupHint}
            value={values.warmup}
            error={state.saveError}
            disabled={busy}
            onValueChange={(warmup) => {
              if (state.status !== "ready") return;
              // Switched off before the tile goes, so warm-up never runs unseen: if that fails,
              // the tile stays on the page.
              const off = warmup ? Promise.resolve() : askWarmup({ enabled: false });
              void off.then(() => state.save({ ...state.values, warmup }, state.revision)).catch(() => undefined);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={strings.settingsThermalTitle}>
        <SettingsCard>
          <SettingsSelect
            label={strings.settingsPressure}
            value={level}
            options={[
              { label: strings.settingsPressureHeavy, value: "heavy" },
              { label: strings.settingsPressureModerate, value: "moderate" },
            ]}
            disabled={busy}
            // A delay that does not belong to the new level falls back to its default.
            onValueChange={(next) =>
              save({ thermalPressure: next, thermalDelayS: (delaysFor(next) as readonly number[]).includes(values.thermalDelayS) ? values.thermalDelayS : defaultDelay(next) })
            }
          />
          <SettingsSelect
            label={strings.settingsDelay}
            hint={strings.settingsDelayHint}
            value={String(delay)}
            options={delays.map((seconds) => ({ label: delayLabel(seconds, strings), value: String(seconds) }))}
            disabled={busy}
            onValueChange={(next) => save({ thermalDelayS: Number(next) })}
          />
          <SettingsRow label={strings.settingsTrapping} hint={strings.settingsTrappingHint} />
          <SettingsRow label={strings.settingsBattery} hint={strings.settingsBatteryHint} />
          <SettingsRow label={strings.settingsBlind} hint={strings.settingsBlindHint} />
          <SettingsSelect
            label={strings.settingsCooldown}
            hint={strings.settingsCooldownHint}
            value={String(cooldown)}
            options={THERMAL_LIMITS.cooldownsMin.map((minutes) => ({ label: strings.minutes(minutes), value: String(minutes) }))}
            disabled={busy}
            onValueChange={(next) => save({ thermalCooldownMin: Number(next) })}
          />
          <SettingsRow label={strings.settingsAfterTrip} hint={strings.settingsAfterTripHint} />
          <SettingsRow label={strings.settingsFansNote} hint={strings.settingsFansNoteHint} />
          <SettingsAction
            label={strings.settingsThermalReset}
            actionLabel={strings.settingsThermalResetAction}
            disabled={busy}
            onPress={() =>
              save({
                thermalPressure: defaultPreferences.thermalPressure,
                thermalDelayS: defaultPreferences.thermalDelayS,
                thermalCooldownMin: defaultPreferences.thermalCooldownMin,
                fanPct: defaultPreferences.fanPct,
                fanDelayS: defaultPreferences.fanDelayS,
              })
            }
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
