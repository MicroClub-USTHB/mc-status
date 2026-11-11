import { describe, expect, expectTypeOf, it } from "vitest";
import {
  applyOutcome,
  initialState,
  type CheckState,
  type ProbeOutcome,
} from "./state";

it("limits probe kinds to success, failure, and unavailable", () => {
  expectTypeOf<ProbeOutcome["kind"]>().toEqualTypeOf<
    "success" | "failure" | "unavailable"
  >();
});

describe.each(["http", "tcp", "dns", "tls"] as const)("%s state", (type) => {
  const failure: ProbeOutcome = { type, kind: "failure", reason: "connection" };
  const success: ProbeOutcome = { type, kind: "success" };

  it("confirms initial down only on the third failure and alerts once", () => {
    let state = initialState(`project/${type}`);
    for (const at of [1000, 2000]) {
      const result = applyOutcome(state, failure, at);
      expect(result).toMatchObject({
        next: { state: "unknown", consecutiveFailures: at / 1000, since: null },
        sample: false,
        event: null,
      });
      state = result.next;
    }
    const down = applyOutcome(state, failure, 3000);
    expect(down).toMatchObject({
      next: { state: "down", consecutiveFailures: 3, since: 3000 },
      event: { kind: "down" },
    });
    const repeated = applyOutcome(down.next, failure, 4000);
    expect(repeated).toMatchObject({
      next: { state: "down", consecutiveFailures: 3, since: 3000 },
      event: null,
    });
  });

  it("starts up silently and resets interrupted failure streaks", () => {
    const up = applyOutcome(initialState(`project/${type}`), success, 1000);
    expect(up).toMatchObject({
      next: {
        state: "up",
        since: 1000,
        consecutiveFailures: 0,
        lastError: null,
      },
      sample: true,
      event: null,
    });
    const failedOnce = applyOutcome(up.next, failure, 2000);
    const failedTwice = applyOutcome(failedOnce.next, failure, 3000);
    expect(failedOnce.event).toBeNull();
    expect(failedTwice.next.state).toBe("up");
    const reset = applyOutcome(failedTwice.next, success, 4000);
    expect(reset).toMatchObject({
      next: {
        state: "up",
        since: 1000,
        consecutiveFailures: 0,
        lastError: null,
      },
      event: null,
    });
    expect(applyOutcome(reset.next, failure, 5000)).toMatchObject({
      next: { state: "up", consecutiveFailures: 1 },
      event: null,
    });
  });

  it("alerts on up-to-down and recovers once with confirmed downtime", () => {
    let state = applyOutcome(initialState(`project/${type}`), success, 0).next;
    state = applyOutcome(state, failure, 1000).next;
    state = applyOutcome(state, failure, 2000).next;
    const down = applyOutcome(state, failure, 3000);
    expect(down.event?.kind).toBe("down");
    const recovered = applyOutcome(down.next, success, 8000);
    expect(recovered).toMatchObject({
      next: {
        state: "up",
        since: 8000,
        consecutiveFailures: 0,
        lastError: null,
      },
      sample: true,
      event: { kind: "recovered", error: null, downtimeMs: 5000 },
    });
    expect(applyOutcome(recovered.next, success, 9000)).toMatchObject({
      next: { since: 8000 },
      event: null,
    });
  });
});

describe("TLS certificates", () => {
  it.each(["unknown", "up"] as const)(
    "invalid certificate immediately goes down from %s",
    (state) => {
      const previous: CheckState = {
        ...initialState("project/certificate"),
        state,
        since: state === "up" ? 1000 : null,
      };
      const down = applyOutcome(
        previous,
        { type: "tls", kind: "failure", reason: "invalid_certificate" },
        2000,
      );
      expect(down).toMatchObject({
        next: { state: "down", consecutiveFailures: 1, since: 2000 },
        sample: false,
        event: { kind: "down", error: "Certificate check failed" },
      });
      const repeated = applyOutcome(
        down.next,
        { type: "tls", kind: "failure", reason: "invalid_certificate" },
        3000,
      );
      expect(repeated.event).toBeNull();
      expect(repeated.next.since).toBe(2000);
      expect(
        applyOutcome(repeated.next, { type: "tls", kind: "success" }, 4000)
          .event,
      ).toEqual({ kind: "recovered", error: null, downtimeMs: 2000 });
    },
  );

  it("keeps a valid handshake up; expiry warning bookkeeping is separate", () => {
    const result = applyOutcome(
      initialState("project/certificate"),
      { type: "tls", kind: "success" },
      1000,
    );
    expect(result.next.state).toBe("up");
    expect(result.event).toBeNull();
  });
});

describe("CI state", () => {
  const success: ProbeOutcome = { type: "repo", kind: "success" };
  const failure: ProbeOutcome = {
    type: "repo",
    kind: "failure",
    reason: "ci_failure",
  };

  it("fails immediately, recovers once, and fails again without hysteresis", () => {
    const down = applyOutcome(initialState("project/ci"), failure, 1000);
    expect(down).toMatchObject({
      next: { state: "down", since: 1000 },
      sample: false,
      event: { kind: "down", error: "CI check failed" },
    });
    expect(applyOutcome(down.next, failure, 2000).event).toBeNull();
    const up = applyOutcome(down.next, success, 4000);
    expect(up.event).toEqual({
      kind: "recovered",
      error: null,
      downtimeMs: 3000,
    });
    expect(applyOutcome(up.next, failure, 5000).event?.kind).toBe("down");
    expect(
      applyOutcome(initialState("project/ci"), success, 0).event,
    ).toBeNull();
  });

  it.each(["ignored", "github_unavailable"] as const)(
    "%s preserves unknown/up/down state and excludes uptime",
    (reason) => {
      const initial = initialState("project/ci");
      const states = [
        initial,
        applyOutcome(initial, success, 1000).next,
        applyOutcome(initial, failure, 1000).next,
      ];
      for (const previous of states) {
        const result = applyOutcome(
          previous,
          { type: "repo", kind: "unavailable", reason },
          2000,
        );
        expect(result).toEqual({
          next: { ...previous, lastCheckAt: 2000 },
          sample: null,
          event: null,
        });
      }
    },
  );

  it("preserves confirmed outage duration across ignored and unavailable results", () => {
    let state = applyOutcome(initialState("project/ci"), failure, 0).next;
    state = applyOutcome(
      state,
      { type: "repo", kind: "unavailable", reason: "github_unavailable" },
      1000,
    ).next;
    state = applyOutcome(
      state,
      { type: "repo", kind: "unavailable", reason: "ignored" },
      2000,
    ).next;
    expect(applyOutcome(state, success, 3000).event).toEqual({
      kind: "recovered",
      error: null,
      downtimeMs: 3000,
    });
  });

  it.each(["unknown", "up", "down"] as const)(
    "no CI changes %s to unknown without an alert or uptime sample",
    (state) => {
      const previous: CheckState = {
        checkId: "project/ci",
        state,
        since: 1000,
        consecutiveFailures: 1,
        lastCheckAt: 1000,
        lastError: "CI check failed",
      };
      const result = applyOutcome(
        previous,
        { type: "repo", kind: "unavailable", reason: "no_ci" },
        2000,
      );
      expect(result).toMatchObject({
        next: { state: "unknown", consecutiveFailures: 0, lastError: null },
        sample: null,
        event: null,
      });
      expect(applyOutcome(result.next, success, 3000).event).toBeNull();
    },
  );
});

describe("snapshots and safe results", () => {
  it("does not mutate inputs or share failure counts between sibling checks", () => {
    const web = Object.freeze(initialState("project/web"));
    const dns = Object.freeze(initialState("project/dns"));
    const result = applyOutcome(
      web,
      { type: "http", kind: "failure", reason: "timeout" },
      1000,
    );
    expect(result.next.checkId).toBe("project/web");
    expect(result.next.consecutiveFailures).toBe(1);
    expect(web).toEqual(initialState("project/web"));
    expect(dns).toEqual(initialState("project/dns"));
    expect(result.next.lastError).toBe("Request timed out");
    expect(
      applyOutcome(
        web,
        { type: "http", kind: "failure", reason: "response" },
        1000,
      ).next.lastError,
    ).toBe("HTTP check failed");
  });

  it("continues a saved failure streak and down state without duplicate alerts", () => {
    let state = initialState("project/web");
    const failure: ProbeOutcome = {
      type: "http",
      kind: "failure",
      reason: "connection",
    };
    state = applyOutcome(state, failure, 1000).next;
    state = applyOutcome(state, failure, 2000).next;
    const restored: CheckState = JSON.parse(JSON.stringify(state));
    const down = applyOutcome(restored, failure, 3000);
    expect(down.event?.kind).toBe("down");
    const restoredDown: CheckState = JSON.parse(JSON.stringify(down.next));
    expect(applyOutcome(restoredDown, failure, 4000).event).toBeNull();
    expect(
      applyOutcome(restoredDown, { type: "http", kind: "success" }, 8000).event,
    ).toEqual({ kind: "recovered", error: null, downtimeMs: 5000 });
  });
});
