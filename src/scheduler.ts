import type { Database } from "bun:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { getActiveProjects, type TargetsConfig } from "./config";
import { deleteExpiredSamples, recordProbeResult, type ProbeResultDetails } from "./db";
import { probeDns } from "./probes/dns";
import { probeHttp } from "./probes/http";
import { probeRepo } from "./probes/repo";
import { probeTcp } from "./probes/tcp";
import { probeTls } from "./probes/tls";
import type { ProbeOutcome } from "./state";

const dayMs = 24 * 60 * 60 * 1_000;
const fixedIntervalsMs = { dns: 60_000, tls: 3_600_000, repo: 600_000 };
const probes = { http: probeHttp, tcp: probeTcp, dns: probeDns, tls: probeTls, repo: probeRepo };
let running = false;

export function startScheduler(db: Database, config: TargetsConfig): () => Promise<void> {
  if (running) throw new Error("Monitoring is already running.");
  running = true;

  const controller = new AbortController();
  const { signal } = controller;
  const intervalMs = Math.ceil(config.interval * 1_000);
  const timeoutMs = Math.ceil(config.timeout * 1_000);
  const checks = getActiveProjects(config).flatMap(({ checks }) => checks);

  function cleanUpSamples() {
    try {
      deleteExpiredSamples(db, Date.now());
    } catch {
      console.error("Could not remove expired probe samples.");
    }
  }

  cleanUpSamples();
  const cleanupTimer = setInterval(cleanUpSamples, dayMs);
  const loops = checks.map(async (check) => {
    const { checkId, type } = check;
    const probe = probes[type];
    const address = check.type === "repo" ? check.repo : check.url;
    const cadenceMs = type === "http" || type === "tcp" ? intervalMs : fixedIntervalsMs[type];
    while (!signal.aborted) {
      const startedAt = performance.now();
      try {
        const result: { outcome: ProbeOutcome; latencyMs: number } & ProbeResultDetails =
          await probe(address, timeoutMs, signal);
        if (signal.aborted) return;
        recordProbeResult(db, checkId, result.outcome, Date.now(), result.latencyMs, result);
      } catch {
        if (signal.aborted) return;
        console.error(`Could not process ${type.toUpperCase()} check ${checkId}.`);
      }

      const jitterMs = Math.floor(Math.random() * Math.min(cadenceMs * 0.05, 1_000));
      const waitMs = Math.min(
        2_147_483_647,
        Math.max(1, cadenceMs + jitterMs - (performance.now() - startedAt)),
      );
      try {
        await delay(waitMs, undefined, { signal });
      } catch {
        return; // The stop signal cancels the wait.
      }
    }
  });

  let stopping: Promise<void> | undefined;
  return () => stopping ??= (async () => {
    clearInterval(cleanupTimer);
    controller.abort();
    await Promise.all(loops);
    running = false;
  })();
}
