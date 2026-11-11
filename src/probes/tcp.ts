import { Socket } from "node:net";
import { parseTcpAddress } from "../config/address-validation";
import type { ProbeOutcome } from "../state";

export function probeTcp(
  address: string,
  timeoutMs: number,
  stopSignal?: AbortSignal,
): Promise<{ outcome: ProbeOutcome; latencyMs: number }> {
  const target = parseTcpAddress(address);
  if (!target) throw new Error("Invalid TCP check address.");

  const startedAt = performance.now();
  return new Promise((resolve) => {
    const socket = new Socket();
    let finished = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const onAbort = () => finish("connection");

    function finish(reason?: "connection" | "timeout") {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopSignal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve({
        outcome: reason ? { type: "tcp", kind: "failure", reason } : { type: "tcp", kind: "success" },
        latencyMs: Math.round(performance.now() - startedAt),
      });
    }

    socket.once("connect", () => finish());
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ETIMEDOUT" ? "timeout" : "connection");
    });
    if (stopSignal?.aborted) {
      onAbort();
      return;
    }
    stopSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      socket.connect(target);
    } catch {
      finish("connection");
    }
  });
}
