import type { ProbeOutcome } from "../state";

export interface HttpProbeResult {
  outcome: ProbeOutcome;
  latencyMs: number;
  status?: number;
}

export async function probeHttp(
  url: string,
  timeoutMs: number,
  stopSignal?: AbortSignal,
): Promise<HttpProbeResult> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = stopSignal ? AbortSignal.any([stopSignal, timeoutSignal]) : timeoutSignal;
  const startedAt = performance.now();

  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal });
    const latencyMs = Math.round(performance.now() - startedAt);

    // The status is enough to classify the probe. Release the body without waiting for it.
    void response.body?.cancel().catch(() => {});

    return {
      outcome: response.ok
        ? { type: "http", kind: "success" }
        : { type: "http", kind: "failure", reason: "response" },
      latencyMs,
      status: response.status,
    };
  } catch {
    return {
      outcome: {
        type: "http",
        kind: "failure",
        reason: timeoutSignal.aborted ? "timeout" : "connection",
      },
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
