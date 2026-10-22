export interface AgentsProbe {
  /** Called from every RPC handler; the first call is what makes counting possible. */
  remember(paseo: any): void;
  /** Running agents on this host, or null when nothing can be said yet. */
  runningCount(): Promise<number | null>;
  primed(): boolean;
}

/**
 * The daemon hands its API to RPC handlers and nowhere else, so the probe keeps the
 * most recent one. Until a client has called any RPC after plugin start, the answer is
 * null and the policy treats it as "unknown" — the surface says so, and the client
 * contribution calls caffeine.get as soon as a client connects to close that gap.
 */
export function createAgentsProbe(): AgentsProbe {
  let remembered: any = null;
  return {
    remember(paseo) {
      remembered = paseo;
    },
    primed: () => remembered !== null,
    async runningCount() {
      if (!remembered) return null;
      try {
        const result = await remembered.agents.list();
        // Only the part read here: the daemon's own type is in @getpaseo/client, which this
        // plugin no longer imports (it broke the build on Paseo 0.12.0).
        return result.entries.filter((entry: { agent: { status: string } }) => entry.agent.status === "running").length;
      } catch {
        // A daemon that will not answer is "unknown", which the policy already
        // resolves towards staying awake for the grace period.
        return null;
      }
    },
  };
}
