import type { CheckType } from "./config";

export type CheckStatus = "up" | "down" | "unknown";

export type SafeCheckError =
  | "Connection failed"
  | "Request timed out"
  | "HTTP check failed"
  | "DNS check failed"
  | "Certificate check failed"
  | "CI check failed";

// Probes translate private diagnostics into these bounded outcomes before calling this module.
export type ProbeOutcome =
  | { type: CheckType; kind: "success" }
  | {
      type: "http" | "tcp" | "dns" | "tls";
      kind: "failure";
      reason: "connection" | "timeout";
    }
  | { type: "http"; kind: "failure"; reason: "response" }
  | { type: "tls"; kind: "failure"; reason: "invalid_certificate" }
  | { type: "repo"; kind: "failure"; reason: "ci_failure" }
  | {
      type: "repo";
      kind: "unavailable";
      reason: "github_unavailable" | "ignored" | "no_ci";
    };

export interface CheckState {
  checkId: string;
  state: CheckStatus;
  consecutiveFailures: number;
  since: number | null;
  // Includes inconclusive attempts. The last confirmed result can be older.
  lastCheckAt: number | null;
  lastError: SafeCheckError | null;
}

export type StateEvent =
  | { kind: "down"; error: SafeCheckError }
  | { kind: "recovered"; error: null; downtimeMs: number };

// Persist the state, probe history, and any event together before notifying.
export interface StateResult {
  next: CheckState;
  // NULL means excluded from both the numerator and denominator of uptime.
  sample: boolean | null;
  event: StateEvent | null;
}

export function initialState(checkId: string): CheckState {
  return {
    checkId,
    state: "unknown",
    consecutiveFailures: 0,
    since: null,
    lastCheckAt: null,
    lastError: null,
  };
}

function failureMessage(
  outcome: Extract<ProbeOutcome, { kind: "failure" }>,
): SafeCheckError {
  if (outcome.type === "repo") return "CI check failed";
  if (outcome.type === "tls") return "Certificate check failed";
  if (outcome.type === "dns") return "DNS check failed";

  if (outcome.reason === "timeout") return "Request timed out";
  if (outcome.reason === "response") return "HTTP check failed";

  return "Connection failed";
}

// at, since, and lastCheckAt are Unix milliseconds; time is provided by the caller.
// One snapshot belongs to one full project/check identity. This function does no I/O.
export function applyOutcome(
  previous: CheckState,
  outcome: ProbeOutcome,
  at: number,
): StateResult {
  const next = { ...previous, lastCheckAt: at };

  // Unavailable outcomes do not count toward uptime or produce outage events.
  if (outcome.kind === "unavailable") {
    // No workflow history means unknown; other reasons preserve confirmed state.
    if (outcome.reason === "no_ci") {
      next.state = "unknown";
      next.since = previous.state === "unknown" ? previous.since : at;
      next.consecutiveFailures = 0;
      next.lastError = null;
    }

    return { next, sample: null, event: null };
  }

  const success = outcome.kind === "success";

  next.consecutiveFailures = success
    ? 0
    : Math.min(previous.consecutiveFailures + 1, 3);
  next.lastError = success ? null : failureMessage(outcome);

  // Invalid certificates and failed CI runs bypass the transient-failure threshold.
  if (success) {
    next.state = "up";
  } else if (
    outcome.type === "repo" ||
    outcome.reason === "invalid_certificate" ||
    next.consecutiveFailures >= 3
  ) {
    next.state = "down";
  }

  let event: StateEvent | null = null;

  if (next.state !== previous.state) {
    next.since = at;

    if (next.state === "down") {
      event = { kind: "down", error: next.lastError! };
    } else if (next.state === "up" && previous.state === "down") {
      event = {
        kind: "recovered",
        error: null,
        downtimeMs: Math.max(0, at - previous.since!),
      };
    }
  }

  // A failed probe is an uptime failure even before the confirmed state becomes down.
  return { next, sample: success, event };
}
