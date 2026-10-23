import type { PluginClientContext } from "@getpaseo/plugin/client";
import { getStatus, setMode, setOptions, sleepNow } from "./shared/caffeine.shared.ts";
import { detectAppLocale, t } from "./client/i18n.ts";
import { CaffeineSurface } from "./client/main.client.tsx";
import { CaffeineSettings } from "./client/settings.tsx";
import { contributeLidAlert } from "./client/lid-alert.tsx";

export default function contribute(client: PluginClientContext) {
  // Paseo's own language, not the device's: these titles are fixed here, at registration,
  // and on a machine whose OS and app disagree the device's is the wrong one of the two.
  const strings = t(detectAppLocale());
  client.addSurface("main", CaffeineSurface);

  // The whole page, a second time, under Settings: the same controls are as much a
  // setting as a surface, and Paseo's own settings are where a person goes looking for
  // "does this machine sleep".
  client.addSettingsScreen({ id: "settings", title: strings.title, icon: "Coffee", Component: CaffeineSurface });
  // Next to it, the preferences of the page itself: which tiles it offers at all.
  client.addSettingsScreen({ id: "preferences", title: strings.settingsTitle, icon: "Settings", Component: CaffeineSettings });

  // Kept rather than dropped: `contribute()` has to hand back a cleanup — the app
  // refuses the whole contribution otherwise, sidebar entry and surface included, and
  // says so only in ~/Library/Logs/Paseo/main.log.
  const removeSidebarItem = client.addSidebarItem({ id: "main", title: strings.sidebarTitle, icon: "Coffee", surface: "main" });

  const commands = [
    { id: "off", title: strings.commandOff, input: { mode: "off" } as const },
    { id: "on", title: strings.commandOn, input: { mode: "on" } as const },
    { id: "timer-3h", title: strings.commandTimer(3), input: { mode: "timer", minutes: 180 } as const },
    { id: "auto", title: strings.commandAuto, input: { mode: "auto" } as const },
  ];
  for (const command of commands) {
    client.addCommandCenterItem({
      id: command.id,
      title: command.title,
      icon: "Coffee",
      context: "global",
      keywords: ["caffeine", "sleep", "awake"],
      async onSelect({ rpc }) {
        await rpc(setMode, command.input);
      },
    });
  }

  // Ids start with a letter: the app refuses one that does not, and a single bad item
  // takes the whole client contribution down with it, sidebar entry included.
  const displayCommands = [
    { id: "display-on", title: strings.commandDisplayOn, keepDisplay: true },
    { id: "display-off", title: strings.commandDisplayOff, keepDisplay: false },
  ];
  for (const command of displayCommands) {
    client.addCommandCenterItem({
      id: command.id,
      title: command.title,
      icon: "Coffee",
      context: "global",
      keywords: ["caffeine", "display", "screen", "sleep"],
      async onSelect({ rpc }) {
        await rpc(setOptions, { keepDisplay: command.keepDisplay });
      },
    });
  }

  client.addCommandCenterItem({
    id: "sleep-now",
    title: "Caffeine: sleep now",
    icon: "Moon",
    context: "global",
    keywords: ["caffeine", "sleep", "suspend"],
    async onSelect({ rpc }) {
      await rpc(sleepNow, {});
    },
  });

  // Any connecting client calls caffeine.get once, which hands the daemon's API to the
  // probe and brings the wake anchor up. Without this, auto mode after a daemon restart
  // would count nothing — and the Mac could go to sleep unannounced — until somebody
  // opened the surface.
  void client.rpc(getStatus, {}).catch(() => undefined);

  // A warning in every workspace's header while lid mode keeps the Mac from sleeping.
  const removeLidAlert = contributeLidAlert(client);

  return () => {
    removeLidAlert();
    void removeSidebarItem?.();
  };
}
