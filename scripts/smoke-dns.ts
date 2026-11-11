import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDns } from "../src/probes/dns";
import { startServer } from "../src/server";

const hostname = "fixture.test";
const ipv4 = Buffer.from([192, 0, 2, 1]);
const ipv6 = Buffer.from("20010db8000000000000000000000001", "hex");
const requests: number[] = [];
let mode: "a" | "aaaa" | "empty" | "nxdomain" | "servfail" | "silent" | "partial" = "a";

const responder = await Bun.udpSocket({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, request, port, address) {
      // Echo the question and use a compressed name pointing to its first label.
      let questionEnd = 12;
      while (request[questionEnd]) questionEnd += request[questionEnd]! + 1;
      const type = request.readUInt16BE(questionEnd + 1);
      requests.push(type);
      if (mode === "silent" || (mode === "partial" && type === 28)) return;

      const answer = (mode === "a" || mode === "partial") && type === 1 ? ipv4
        : mode === "aaaa" && type === 28 ? ipv6
        : null;
      const rcode = mode === "nxdomain" ? 3 : mode === "servfail" ? 2 : 0;
      const header = Buffer.alloc(12);
      header.writeUInt16BE(request.readUInt16BE(0), 0);
      header.writeUInt16BE(0x8180 | rcode, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(answer ? 1 : 0, 6);
      const question = request.subarray(12, questionEnd + 5);
      if (!answer) {
        socket.send(Buffer.concat([header, question]), port, address);
        return;
      }
      const record = Buffer.alloc(12);
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(type, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt16BE(answer.length, 10);
      socket.send(Buffer.concat([header, question, record, answer]), port, address);
    },
  },
});

const dnsServer = `127.0.0.1:${responder.port}`;
const success = { type: "dns", kind: "success" };
const failure = { type: "dns", kind: "failure", reason: "connection" };

function probe(timeoutMs = 1_000, signal?: AbortSignal) {
  const resolver = new Resolver({ timeout: 5_000, tries: 1 });
  resolver.setServers([dnsServer]);
  return probeDns(hostname, timeoutMs, signal, resolver);
}

async function waitFor(label: string, condition: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const originalDirectory = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "mc-status-dns-"));
const dbPath = join(directory, "status.db");
const originalResolve4 = Resolver.prototype.resolve4;
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let webStatus = 204;
const web = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(null, { status: webStatus }),
});

try {
  for (const family of ["a", "aaaa", "partial"] as const) {
    mode = family;
    requests.length = 0;
    const result = await probe();
    assert.deepEqual(result.outcome, success);
    assert.ok(result.latencyMs >= 0 && result.latencyMs < 1_000);
    assert.ok(requests.includes(1) && requests.includes(28), "Both record types were queried");
  }

  for (const missing of ["empty", "nxdomain", "servfail"] as const) {
    mode = missing;
    assert.deepEqual((await probe()).outcome, failure);
  }

  mode = "silent";
  const timedOut = await probe(80);
  assert.deepEqual(timedOut.outcome, { type: "dns", kind: "failure", reason: "timeout" });
  assert.ok(timedOut.latencyMs < 1_000);

  requests.length = 0;
  const controller = new AbortController();
  const pending = probe(5_000, controller.signal);
  await waitFor("both pending DNS queries", () => requests.length >= 2);
  controller.abort();
  assert.deepEqual((await pending).outcome, failure);

  // Route the app's per-probe resolver to this fixture without changing application config.
  Resolver.prototype.resolve4 = function (this: Resolver, name: string) {
    this.setServers([dnsServer]);
    return originalResolve4.call(this, name, { ttl: false });
  } as typeof originalResolve4;
  process.chdir(directory);
  process.env.DB_PATH = dbPath;
  await writeFile("targets.yaml", JSON.stringify({
    interval: 0.15,
    timeout: 0.5,
    projects: [{ name: "Fixture", group: "Core", checks: [
      { id: "lookup", type: "dns", url: hostname },
      { id: "web", type: "http", url: web.url.href },
    ] }],
  }));

  mode = "a";
  app = await startServer(0);
  using db = new Database(dbPath, { readonly: true });
  const page = () => fetch(`http://127.0.0.1:${app!.port}/`).then((response) => response.text());
  const dnsSamples = () => db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM checks WHERE check_id = 'fixture/lookup'",
  ).get()!.count;
  const webSamples = () => db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM checks WHERE check_id = 'fixture/web'",
  ).get()!.count;
  const outages = () => db.query("SELECT check_id, kind FROM events ORDER BY id").all();
  await waitFor("initial DNS and HTTP success", async () => (await page()).includes("All checks passing"));

  mode = "nxdomain";
  for (let failures = 1; failures <= 3; failures++) {
    await app.stop();
    app = await startServer(0);
    await waitFor(`DNS failure ${failures}`, () => dnsSamples() === failures + 1);
    const html = await page();
    if (failures < 3) {
      assert.match(html, /Last probe failed · DNS check failed/);
      assert.doesNotMatch(html, /DNS check failing/);
      assert.deepEqual(outages(), []);
    } else {
      assert.match(html, /1 DNS check failing/);
      assert.doesNotMatch(html, /service check failing|fixture\.test/);
      assert.match(html, /Fixture · lookup \(DNS\)/);
      assert.deepEqual(outages(), [{ check_id: "fixture/lookup", kind: "down" }]);
    }
  }

  webStatus = 503;
  await waitFor("both separate outage counts", async () => {
    const html = await page();
    return html.includes("1 service check failing") && html.includes("1 DNS check failing");
  });
  mode = "aaaa";
  await app.stop();
  app = await startServer(0);
  await waitFor("the DNS recovery sample", () => dnsSamples() === 5);
  const recovered = await page();
  assert.match(recovered, /1 service check failing/);
  assert.doesNotMatch(recovered, /DNS check failing/);
  assert.deepEqual(outages(), [
    { check_id: "fixture/lookup", kind: "down" },
    { check_id: "fixture/web", kind: "down" },
    { check_id: "fixture/lookup", kind: "recovered" },
  ]);
  assert.match(recovered.replace(/<[^>]+>/g, ""), /24h uptime 40%/);

  await app.stop();
  const priorWebSamples = webSamples();
  requests.length = 0;
  mode = "silent";
  webStatus = 204;
  app = await startServer(0);
  await waitFor("HTTP to repeat while DNS is waiting", () =>
    webSamples() >= priorWebSamples + 2 && requests.length >= 2,
  );
  assert.equal(dnsSamples(), 5);
  await app.stop();
  assert.equal(dnsSamples(), 5, "Shutdown cancels DNS without saving a failed sample");
} finally {
  await app?.stop();
  await web.stop(true);
  responder.close();
  Resolver.prototype.resolve4 = originalResolve4;
  process.chdir(originalDirectory);
  await rm(directory, { recursive: true, force: true });
}

console.log("DNS probe and core flow smoke checks passed.");
