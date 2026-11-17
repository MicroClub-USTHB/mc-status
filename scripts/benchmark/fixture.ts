import { rename } from "node:fs/promises";
import { join } from "node:path";
import { getActiveProjects, parseTargetsYaml } from "../../src/config";
import { openDatabase } from "../../src/db";

const [directory, days] = process.argv.slice(2);
const historyDays = Number(days ?? 30);
if (!directory || !Number.isInteger(historyDays) || historyDays < 0 || historyDays > 30) {
  throw new Error("Pass a benchmark directory and a history length from 0 to 30 days.");
}

// One loopback server answers all 18 checks, each of which has its own check ID.
const target = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(null, { status: 204 }),
});

const interval = 60;
const config = JSON.stringify({
  interval,
  timeout: 10,
  projects: Array.from({ length: 9 }, (_, index) => ({
    name: `Benchmark Service ${index + 1}`,
    group: "Core",
    checks: ["web", "api"].map((id) => ({ id, type: "http", url: target.url.href })),
  })),
}, null, 2);
const checkIds = getActiveProjects(parseTargetsYaml(config))
  .flatMap(({ checks }) => checks.map(({ checkId }) => checkId));

const minutes = historyDays * 24 * 60;
const step = interval * 1_000;
// Seed the app's SQLite schema so the status page starts with realistic history.
const db = openDatabase(join(directory, "mc-status.db"));
try {
  if (minutes > 0) {
    // Interleave the checks as the scheduler would during each round.
    db.query(`
      WITH RECURSIVE ticks(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM ticks WHERE n < $minutes
      )
      INSERT INTO checks (check_id, ts, ok, latency_ms)
      SELECT ids.value, $start + ticks.n * $step, 1, 25
      FROM ticks CROSS JOIN json_each($ids) AS ids
    `).run({ minutes, start: Date.now() - minutes * step, step, ids: JSON.stringify(checkIds) });
  }
} finally {
  db.close();
}

// The runner treats the published configuration as the fixture readiness signal.
const configPath = join(directory, "targets.yaml");
await Bun.write(`${configPath}.tmp`, config);
console.log(`${checkIds.length} active checks, ${checkIds.length * minutes} seeded samples`);
await rename(`${configPath}.tmp`, configPath);
