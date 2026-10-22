import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { type LidStatus, getStatus, setLid } from "../shared/caffeine.shared.ts";
import { type Strings, detectAppLocale, formatRemaining, t } from "./i18n.ts";
import { trackWorkspaces } from "./workspace-registry.ts";

/** How often the header re-reads lid mode: often enough that the alert appears soon after
 *  the tile is pressed elsewhere, and its countdown stays within a minute. */
const POLL_MS = 15_000;

function remainingOf(lid: LidStatus, now: number): string | null {
  if (lid.until === "") return null;
  return formatRemaining(Math.max(0, Date.parse(lid.until) - now), t(detectAppLocale()));
}

function labelFor(lid: LidStatus, strings: Strings, now: number): string {
  if (lid.forever) return strings.lidAlertLabelForever;
  const left = remainingOf(lid, now);
  return left === null ? strings.lidAlertLabelNoTimer : strings.lidAlertLabel(left);
}

/** The warning colour, so the button reads as "something is switched off" rather than as a tool. */
function AlertIcon({ size, theme }: PluginButtonIconProps) {
  return <Icon name="LaptopMinimalCheck" size={size} color={theme.colors.statusWarning} />;
}

/**
 * A header button on every workspace, shown only while lid mode is on: sleep is switched off
 * system-wide then, and that should not be easy to forget. Pressing it turns lid mode off.
 */
export function contributeLidAlert(client: PluginClientContext): () => void {
  const strings = t(detectAppLocale());
  let lid: LidStatus = { on: false, until: "", minutes: 0, forever: false, ended: "", stopped: "", setup: "unknown", error: "" };
  const buttons = new Set<PluginButtonRegistration>();

  const apply = () => {
    const label = labelFor(lid, strings, Date.now());
    for (const button of buttons) button.update({ visible: lid.on, label });
  };

  const refresh = () =>
    client
      .rpc(getStatus, {})
      .then((status) => {
        lid = status.lid;
        apply();
      })
      .catch(() => undefined);

  const turnOff = () =>
    client
      .rpc(setLid, { lid: "off" })
      .then((status) => {
        lid = status.lid;
        apply();
      })
      .catch(() => undefined);

  const stopTracking = trackWorkspaces(client.paseo.workspaces, (workspaceId) => {
    const created = client.addHeaderButton({
      id: "lid",
      workspaceId,
      button: {
        title: strings.lidAlertTitle,
        icon: AlertIcon,
        label: labelFor(lid, strings, Date.now()),
        visible: lid.on,
        // An action, not a popover: the host keeps a popover's open state per button rather than
        // per place on screen, so with a workspace mounted twice it opens two popovers, one of
        // them unanchored in the corner (seen in Paseo 0.12.0). A press turns lid mode off:
        // the safe direction, sleep simply comes back, so it needs no confirmation.
        behavior: { kind: "action", onPress: turnOff },
      },
    });
    buttons.add(created);
    return {
      update: (patch) => created.update(patch),
      remove: () => {
        buttons.delete(created);
        created.remove();
      },
    };
  });

  void refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);
  return () => {
    clearInterval(timer);
    stopTracking();
  };
}
