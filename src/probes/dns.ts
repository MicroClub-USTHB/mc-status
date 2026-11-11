import { Resolver } from "node:dns/promises";
import type { ProbeOutcome } from "../state";

async function requireAddresses(query: Promise<string[]>): Promise<void> {
  if ((await query).length === 0) throw new Error("No DNS addresses.");
}

export async function probeDns(
  hostname: string,
  timeoutMs: number,
  stopSignal?: AbortSignal,
  resolver = new Resolver(),
): Promise<{ outcome: ProbeOutcome; latencyMs: number }> {
  const startedAt = performance.now();
  const cancel = () => resolver.cancel();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, timeoutMs);
  stopSignal?.addEventListener("abort", cancel, { once: true });

  let outcome: ProbeOutcome;
  try {
    if (stopSignal?.aborted) throw new Error("DNS check cancelled.");
    await Promise.any([
      requireAddresses(resolver.resolve4(hostname)),
      requireAddresses(resolver.resolve6(hostname)),
    ]);
    outcome = { type: "dns", kind: "success" };
  } catch (error) {
    const resolverTimedOut = error instanceof AggregateError &&
      error.errors.some((failure) => failure?.code === "ETIMEOUT");
    outcome = {
      type: "dns",
      kind: "failure",
      reason: timedOut || resolverTimedOut ? "timeout" : "connection",
    };
  } finally {
    clearTimeout(timer);
    stopSignal?.removeEventListener("abort", cancel);
    // An answer from one family is enough. Release the other query if it's still pending.
    cancel();
  }

  return { outcome, latencyMs: Math.round(performance.now() - startedAt) };
}
