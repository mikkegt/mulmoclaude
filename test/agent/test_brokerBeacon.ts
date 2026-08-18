// The broker's startup beacon decides whether a failed turn is replayed
// (#2842), so a beacon lost to a transient network hiccup would be read as a
// broker that never started — and the turn refused a replay that would have
// worked. These tests pin that one delivery failure is not one lost beacon,
// and that the retry can never reject into the `initialize` handler that
// fires it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deliverBeacon, type BeaconDelivery } from "../../server/agent/brokerBeacon.js";

const POLICY = { attempts: 3, retryDelayMs: 1000 };

interface Recorder {
  delivery: BeaconDelivery;
  sends: number;
  waits: number[];
  reports: { attempts: number; error: unknown }[];
}

// `outcomes` is read one per attempt: `true` resolves, `false` rejects.
function recorder(outcomes: boolean[]): Recorder {
  const rec: Recorder = {
    sends: 0,
    waits: [],
    reports: [],
    delivery: {
      send: async () => {
        const ok = outcomes[rec.sends] ?? false;
        rec.sends += 1;
        if (!ok) throw new Error(`attempt ${rec.sends} failed`);
      },
      wait: async (delayMs: number) => {
        rec.waits.push(delayMs);
      },
      report: (attempts: number, error: unknown) => {
        rec.reports.push({ attempts, error });
      },
    },
  };
  return rec;
}

describe("deliverBeacon", () => {
  it("sends once and stops when the first attempt succeeds", async () => {
    const rec = recorder([true]);
    assert.equal(await deliverBeacon(rec.delivery, POLICY), true);
    assert.equal(rec.sends, 1);
    assert.deepEqual(rec.waits, []);
    assert.deepEqual(rec.reports, []);
  });

  // The case the retry exists for: one dropped POST used to be a permanently
  // absent beacon.
  it("retries after a failure and reports success on the second attempt", async () => {
    const rec = recorder([false, true]);
    assert.equal(await deliverBeacon(rec.delivery, POLICY), true);
    assert.equal(rec.sends, 2);
    assert.deepEqual(rec.waits, [POLICY.retryDelayMs]);
    assert.deepEqual(rec.reports, []);
  });

  it("uses the last attempt when every earlier one fails", async () => {
    const rec = recorder([false, false, true]);
    assert.equal(await deliverBeacon(rec.delivery, POLICY), true);
    assert.equal(rec.sends, 3);
    assert.deepEqual(rec.waits, [POLICY.retryDelayMs, POLICY.retryDelayMs]);
  });

  it("gives up after the budget and reports the final error", async () => {
    const rec = recorder([]);
    assert.equal(await deliverBeacon(rec.delivery, POLICY), false);
    assert.equal(rec.sends, 3);
    // Waits happen BETWEEN attempts, so three attempts means two pauses — a
    // third would delay the give-up report for nothing.
    assert.deepEqual(rec.waits, [POLICY.retryDelayMs, POLICY.retryDelayMs]);
    assert.equal(rec.reports.length, 1);
    assert.equal(rec.reports[0]?.attempts, 3);
    assert.match(String(rec.reports[0]?.error), /attempt 3 failed/);
  });

  it("makes exactly one attempt when the policy allows one", async () => {
    const rec = recorder([]);
    assert.equal(await deliverBeacon(rec.delivery, { attempts: 1, retryDelayMs: 1000 }), false);
    assert.equal(rec.sends, 1);
    assert.deepEqual(rec.waits, []);
    assert.equal(rec.reports.length, 1);
  });

  it("sends nothing when the policy allows no attempts", async () => {
    const rec = recorder([true]);
    assert.equal(await deliverBeacon(rec.delivery, { attempts: 0, retryDelayMs: 1000 }), false);
    assert.equal(rec.sends, 0);
    assert.deepEqual(rec.reports, []);
  });

  it("sends nothing on a negative budget", async () => {
    const rec = recorder([true]);
    assert.equal(await deliverBeacon(rec.delivery, { attempts: -1, retryDelayMs: 1000 }), false);
    assert.equal(rec.sends, 0);
  });

  // The caller is `initialize`'s fire-and-forget path: a rejection there becomes
  // an unhandled rejection in the broker, not a logged beacon failure. The
  // reporter is the reachable case — it writes to a stderr pipe Claude CLI owns,
  // and a CLI that has already exited makes that write throw EPIPE.
  //
  // The previous version of this test named the reporter and then handed it one
  // that could not throw, so it asserted nothing about its own claim (Codex
  // review on #2931).
  it("never rejects when the reporter throws", async () => {
    const delivery: BeaconDelivery = {
      send: () => Promise.reject(new Error("network down")),
      wait: () => Promise.resolve(),
      report: () => {
        throw new Error("EPIPE: broken pipe");
      },
    };
    assert.equal(await deliverBeacon(delivery, { attempts: 1, retryDelayMs: 0 }), false);
  });

  it("never rejects when the retry wait rejects", async () => {
    const delivery: BeaconDelivery = {
      send: () => Promise.reject(new Error("network down")),
      wait: () => Promise.reject(new Error("timer failed")),
      report: () => undefined,
    };
    assert.equal(await deliverBeacon(delivery, POLICY), false);
  });

  // Both at once: the wait fails, and the reporter that would have logged it
  // fails too. Still resolves.
  it("never rejects when every injected dependency throws", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const delivery: BeaconDelivery = {
      send: boom,
      wait: boom,
      report: boom,
    };
    assert.equal(await deliverBeacon(delivery, POLICY), false);
  });
});
