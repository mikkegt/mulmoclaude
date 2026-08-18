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
 *  Never rejects: the only caller is the `initialize` handler, which fires this
 *  and moves on — a rejection there becomes an unhandled rejection in the
 *  broker rather than a logged beacon failure, which is a worse outcome than
 *  any beacon is worth.
 *
 *  "Never" is enforced at the boundary rather than argued call by call. Only
 *  `send` is caught inside the loop, because only its failure means "retry";
 *  `wait` and `report` throwing mean the beacon is not going to be delivered,
 *  which is what `false` already says. Containing it in one place also means a
 *  later edit inside the loop cannot quietly reintroduce the escape — the
 *  reporter is the real risk, since it writes to a stderr pipe Claude CLI owns
 *  and a CLI that has already exited turns that write into an EPIPE throw. */
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

  return attempt(policy.attempts).catch(() => false);
}
