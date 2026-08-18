// Delivering the MCP broker's startup beacon (#2842).
//
// The beacon used to be a single fire-and-forget POST: any transient failure —
// a 2 s timeout against a busy host, a connection reset — dropped it for good.
// That was tolerable while it only decorated a warn.
//
// It is not tolerable now that the host DECIDES on it: a beacon lost in flight
// reads as "the broker never came up", which is the reading that skips the
// replay. Retrying is what keeps a delivery failure from being mistaken for a
// broker failure.

export interface BeaconDelivery {
  /** One delivery attempt. Must reject on network error AND on HTTP failure. */
  send: () => Promise<unknown>;
  /** Pause between attempts. Injected so a test spends no real time. */
  wait: (delayMs: number) => Promise<void>;
  /** Called once, with the final error, when every attempt failed. */
  report: (attempts: number, error: unknown) => void;
}

export interface BeaconRetryPolicy {
  attempts: number;
  retryDelayMs: number;
}

/** Send until an attempt succeeds or the budget runs out, and report which.
 *
 *  Never rejects: the only caller is the `initialize` handler, which must not
 *  be delayed or broken by the beacon it fires — a beacon that made the
 *  handshake slower would worsen the very race it exists to measure. */
export async function deliverBeacon(delivery: BeaconDelivery, policy: BeaconRetryPolicy): Promise<boolean> {
  if (policy.attempts < 1) return false;

  const attempt = async (remaining: number): Promise<boolean> => {
    try {
      await delivery.send();
      return true;
    } catch (err) {
      if (remaining <= 1) {
        delivery.report(policy.attempts, err);
        return false;
      }
      await delivery.wait(policy.retryDelayMs);
      return attempt(remaining - 1);
    }
  };

  return attempt(policy.attempts);
}
