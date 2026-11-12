import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";

const directory = await mkdtemp(join(tmpdir(), "mc-status-core-"));
const dbPath = join(directory, "status.db");
const checkId = "fixture/web";
let base = "";
let failNextHttpProbe = false;

function serveTarget(port = 0) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch() {
      if (failNextHttpProbe) {
        failNextHttpProbe = false;
        return new Response("private failure body", { status: 503 });
      }
      return new Response(null, { status: 204 });
    },
  });
}

function listenTcp(port = 0) {
  return Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
}

function startApp() {
  let port: number | null = null;
  const entry = JSON.stringify(resolve("src/server.ts"));
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    const { startServer } = await import(${entry});
    const { port, stop } = await startServer(0);
    process.on("message", async (message) => {
      if (message === "stop") {
        await stop();
        process.disconnect();
      }
    });
    process.send(port);
  `], {
    cwd: directory,
    env: { ...process.env, DB_PATH: dbPath, DISCORD_WEBHOOK_URL: "" },
    stdout: "inherit",
    stderr: "inherit",
    ipc(message) {
      if (typeof message === "number") port = message;
    },
  });
  return { child, getPort: () => port };
}

let app: ReturnType<typeof startApp> | undefined;
let target: ReturnType<typeof serveTarget> | undefined;
let tcpTarget: ReturnType<typeof listenTcp> | undefined;

async function stopApp() {
  if (!app) return;
  const { child } = app;
  app = undefined;
  if (child.exitCode !== null) return;
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    child.send("stop");
    assert.equal(await child.exited, 0, "mc-status shut down cleanly");
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor<T>(label: string, read: () => T | null | Promise<T | null>): Promise<T> {
  const deadline = performance.now() + 7_000;
  while (performance.now() < deadline) {
    if (app?.child.exitCode != null) throw new Error(`mc-status exited with code ${app.child.exitCode}.`);
    const result = await read();
    if (result !== null) return result;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function page() {
  const response = await fetch(base, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
  return response?.ok ? response.text() : null;
}

async function waitForPage(label: string, text: string) {
  return waitFor(label, async () => {
    const html = await page();
    return html?.includes(text) ? html : null;
  });
}

try {
  target = serveTarget();
  tcpTarget = listenTcp();
  const targetPort = target.port!;
  const tcpPort = tcpTarget.port;
  const targetUrl = `${target.url}health?private=fixture-secret`;
  await writeFile(join(directory, "targets.yaml"), stringify({
    interval: 0.5,
    timeout: 0.2,
    projects: [{
      name: "Fixture",
      group: "Core",
      checks: [
        { id: "web", type: "http", url: targetUrl },
        { id: "socket", type: "tcp", url: `127.0.0.1:${tcpPort}` },
        { id: "disabled-check", type: "http", url: "" },
      ],
    }],
  }));

  app = startApp();
  base = `http://127.0.0.1:${await waitFor("the server port", app.getPort)}`;
  const up = await waitForPage("the initial successful probe", "All checks passing");
  assert.match(up, /class="state-badge" data-state="up">Up</);
  assert.match(up.replace(/<[^>]+>/g, ""), /24h uptime 100%/);
  assert.match(up, />TCP</);
  assert.doesNotMatch(up, /fixture-secret|disabled-check/);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");
  const stylesheet = await fetch(`${base}/assets/status.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /^text\/css/);
  assert.match(await stylesheet.text(), /\.state-badge\[data-state=("|')?down\b/);
  for (const path of ["/targets.yaml", "/status.db", "/data/mc-status.db", "/.env"]) {
    assert.equal((await fetch(base + path)).status, 404);
  }

  using db = new Database(dbPath, { readonly: true });
  const state = db.query<{
    state: string;
    consecutive_failures: number;
    last_check_at: number;
  }, [string]>("SELECT state, consecutive_failures, last_check_at FROM state WHERE check_id = ?");
  const events = db.query("SELECT check_id, kind FROM events ORDER BY id");
  const samples = db.query("SELECT COUNT(*) AS count FROM checks");
  const httpDown = { check_id: checkId, kind: "down" };
  const httpRecovered = { check_id: checkId, kind: "recovered" };
  const tcpCheckId = "fixture/socket";

  failNextHttpProbe = true;
  const http503 = await waitForPage("a single HTTP 503", "Last probe failed · HTTP check failed");
  assert.doesNotMatch(http503, /private failure body/);
  assert.equal(state.get(checkId)?.consecutive_failures, 1);
  await waitForPage("a success after the single failure", "All checks passing");
  assert.equal(state.get(checkId)?.consecutive_failures, 0);
  assert.deepEqual(events.all(), []);

  await target.stop(true);
  target = undefined;
  const firstFailure = await waitForPage("the first failed probe", "1 check with a failed last probe");
  assert.match(firstFailure, /class="state-badge" data-state="up">Up</);
  assert.match(firstFailure, /Last probe failed · Connection failed/);
  assert.deepEqual(events.all(), []);

  const down = await waitForPage("a confirmed outage", "1 service check failing");
  assert.match(down, /class="state-badge" data-state="down">Down</);
  assert.match(down, /Recent outages/);
  assert.equal(state.get(checkId)?.consecutive_failures, 3);
  assert.equal(state.get(tcpCheckId)?.state, "up");
  assert.deepEqual(events.all(), [httpDown]);
  const beforeRestart = state.get(checkId)!.last_check_at;
  const savedSamples = samples.get();

  await stopApp();
  app = startApp();
  base = `http://127.0.0.1:${await waitFor("the restarted server port", app.getPort)}`;
  await waitForPage("the saved outage after restart", "1 service check failing");
  await waitFor("another probe after restart", () =>
    (state.get(checkId)?.last_check_at ?? 0) > beforeRestart ? true : null,
  );
  assert.notDeepEqual(samples.get(), savedSamples);
  assert.deepEqual(events.all(), [httpDown]);

  target = serveTarget(targetPort);
  const recovered = await waitForPage("recovery on the page", "All checks passing");
  assert.match(recovered, /class="event-kind">Recovered</);
  assert.deepEqual(events.all(), [httpDown, httpRecovered]);

  tcpTarget.stop(true);
  tcpTarget = undefined;
  const firstTcpFailure = await waitForPage("the first TCP failure", "1 check with a failed last probe");
  assert.match(firstTcpFailure, /Last probe failed · Connection failed/);
  assert.equal(state.get(tcpCheckId)?.state, "up");
  assert.deepEqual(events.all(), [httpDown, httpRecovered]);

  const tcpDown = await waitForPage("the confirmed TCP outage", "1 service check failing");
  assert.match(tcpDown, /Fixture · socket \(TCP\)/);
  assert.equal(state.get(tcpCheckId)?.consecutive_failures, 3);
  assert.equal(state.get(checkId)?.state, "up");
  const tcpDownEvent = { check_id: tcpCheckId, kind: "down" };
  assert.deepEqual(events.all(), [httpDown, httpRecovered, tcpDownEvent]);

  const tcpBeforeRestart = state.get(tcpCheckId)!.last_check_at;
  await stopApp();
  app = startApp();
  base = `http://127.0.0.1:${await waitFor("the server port after the TCP outage", app.getPort)}`;
  await waitForPage("the saved TCP outage after restart", "1 service check failing");
  await waitFor("another TCP probe after restart", () =>
    (state.get(tcpCheckId)?.last_check_at ?? 0) > tcpBeforeRestart ? true : null,
  );
  assert.deepEqual(events.all(), [httpDown, httpRecovered, tcpDownEvent]);

  tcpTarget = listenTcp(tcpPort);
  await waitForPage("TCP recovery", "All checks passing");
  assert.deepEqual(events.all(), [
    httpDown, httpRecovered, tcpDownEvent, { check_id: tcpCheckId, kind: "recovered" },
  ]);
} finally {
  await stopApp();
  await target?.stop(true);
  tcpTarget?.stop(true);
  await rm(directory, { recursive: true, force: true });
}

console.log("HTTP and TCP core flow smoke checks passed.");
