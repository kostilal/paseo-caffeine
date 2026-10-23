import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { defaultPreferences, preferences, setWarmup } from "../shared/caffeine.shared.ts";
import { detectAppLocale, t } from "./i18n.ts";

/** Settings → Plugins → Caffeine → Settings: whether the page offers Session warm-up at all. */
export function CaffeineSettings() {
  const strings = t(detectAppLocale());
  const state = useSettings(preferences);
  const askWarmup = useRpc(setWarmup);
  const values = state.status === "ready" ? state.values : defaultPreferences;
  return (
    <View style={{ gap: 12 }}>
      <SettingsSection title={strings.title}>
        <SettingsCard>
          <SettingsSwitch
            label={strings.warmupLabel}
            hint={strings.settingsWarmupHint}
            value={values.warmup}
            error={state.saveError}
            disabled={state.status !== "ready" || state.saving}
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
    </View>
  );
}
