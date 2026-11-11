import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSecureContext, createServer } from "node:tls";
import { probeTls } from "../src/probes/tls";

const gitOpenSsl = "C:/Program Files/Git/mingw64/bin/openssl.exe";
const openssl = Bun.which("openssl") ?? (existsSync(gitOpenSsl) ? gitOpenSsl : null);
if (!openssl) throw new Error("OpenSSL is required to generate local TLS smoke fixtures.");

const directory = await mkdtemp(join(tmpdir(), "mc-status-tls-"));
const caPath = join(directory, "ca.crt");
const dbPath = join(directory, "status.db");
const day = 24 * 60 * 60 * 1_000;
const now = Date.now();
const success = { type: "tls", kind: "success" };
const invalid = { type: "tls", kind: "failure", reason: "invalid_certificate" };
const connectionFailure = { type: "tls", kind: "failure", reason: "connection" };
let lastServerName: string | undefined;

function generate(args: string[]) {
  const result = Bun.spawnSync([openssl!, ...args], {
    cwd: directory, stdout: "ignore", stderr: "pipe",
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
}

function opensslDate(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "") + "Z";
}

async function listenTls(key: Buffer, cert: Buffer, port = 0) {
  const context = createSecureContext({ key, cert });
  const server = createServer({
    key, cert,
    SNICallback(name, callback) {
      lastServerName = name;
      callback(null, context);
    },
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () => new Promise<void>((done, reject) => {
      server.close((error) => error ? reject(error) : done());
    }),
  };
}

async function waitFor<T>(label: string, read: () => T | null | Promise<T | null>): Promise<T> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
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
    env: { ...process.env, DB_PATH: dbPath, NODE_EXTRA_CA_CERTS: caPath, DISCORD_WEBHOOK_URL: "" },
    stdout: "inherit",
    stderr: "inherit",
    ipc(message) {
      if (typeof message === "number") port = message;
    },
  });
  return {
    getPort() {
      if (child.exitCode !== null) throw new Error(`mc-status exited with code ${child.exitCode}.`);
      return port;
    },
    async stop() {
      if (child.exitCode !== null) return;
      const timer = setTimeout(() => child.kill(), 3_000);
      try {
        child.send("stop");
        assert.equal(await child.exited, 0);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

try {
  await writeFile(join(directory, "index.txt"), "");
  await writeFile(join(directory, "serial"), "1000\n");
  await writeFile(join(directory, "ca.cnf"), `
[ca]
default_ca = fixture
[fixture]
database = index.txt
new_certs_dir = .
serial = serial
private_key = ca.key
certificate = ca.crt
default_md = sha256
policy = policy
unique_subject = no
[policy]
commonName = supplied
[leaf]
basicConstraints = critical,CA:FALSE
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
[wrong]
basicConstraints = critical,CA:FALSE
extendedKeyUsage = serverAuth
subjectAltName = DNS:wrong.test
`);
  const keyArgs = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  generate(["req", "-x509", ...keyArgs, "-subj", "/CN=TLS fixture CA", "-days", "90",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca.key", "-out", "ca.crt"]);
  generate(["req", "-new", ...keyArgs, "-subj", "/CN=localhost", "-keyout", "leaf.key", "-out", "leaf.csr"]);

  async function sign(name: string, from: number, to: number, extension = "leaf") {
    generate(["ca", "-config", "ca.cnf", "-batch", "-notext", "-extensions", extension,
      "-startdate", opensslDate(from), "-enddate", opensslDate(to),
      "-in", "leaf.csr", "-out", `${name}.crt`]);
    return readFile(join(directory, `${name}.crt`));
  }

  const ca = await readFile(caPath);
  const key = await readFile(join(directory, "leaf.key"));
  const warning = await sign("warning", now - day, now + 7 * day);
  const renewed = await sign("renewed", now - day, now + 30 * day);
  const expired = await sign("expired", now - 7 * day, now - day);
  const future = await sign("future", now + day, now + 7 * day);
  const wrong = await sign("wrong", now - day, now + 7 * day, "wrong");

  for (const [cert, expected] of [
    [warning, success], [renewed, success], [expired, invalid], [future, invalid], [wrong, invalid],
  ] as const) {
    const server = await listenTls(key, cert);
    try {
      const result = await probeTls(`https://localhost:${server.port}/ignored`, 2_000, undefined, ca);
      assert.deepEqual(result.outcome, expected);
      assert.deepEqual(result.certificate, {
        fingerprint: new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase(),
        expiresAt: Date.parse(new X509Certificate(cert).validTo),
      });
      if (cert === warning) {
        assert.equal(lastServerName, "localhost");
        assert.deepEqual((await probeTls(`https://127.0.0.1:${server.port}`, 2_000, undefined, ca)).outcome, success);
        const untrusted = await probeTls(`https://localhost:${server.port}`, 2_000);
        assert.deepEqual(untrusted.outcome, invalid);
        assert.deepEqual(untrusted.certificate, result.certificate);
      }
    } finally {
      await server.close();
    }
    assert.deepEqual((await probeTls(`https://127.0.0.1:${server.port}`, 500)).outcome, connectionFailure);
  }

  const stalled = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const url = `https://127.0.0.1:${stalled.port}`;
    const timedOut = await probeTls(url, 80);
    assert.deepEqual(timedOut.outcome, { type: "tls", kind: "failure", reason: "timeout" });
    assert.equal(timedOut.certificate, undefined);
    const controller = new AbortController();
    const pending = probeTls(url, 5_000, controller.signal);
    controller.abort();
    assert.deepEqual((await pending).outcome, connectionFailure);
  } finally {
    stalled.stop(true);
  }

  console.log("Local TLS certificate, trust, hostname, timeout, and cancellation checks passed.");

  let app: ReturnType<typeof startApp> | undefined;
  let tlsTarget: Awaited<ReturnType<typeof listenTls>> | undefined;
  let bareTarget: Bun.TCPSocketListener<undefined> | undefined;
  let statusUrl = "";
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
  try {
    tlsTarget = await listenTls(key, warning);
    const targetPort = tlsTarget.port;
    await writeFile(join(directory, "targets.yaml"), JSON.stringify({
      interval: 0.1,
      timeout: 0.5,
      projects: [{ name: "Fixture", group: "Core", checks: [
        { id: "web", type: "http", url: web.url.href },
        { id: "cert", type: "tls", url: `https://localhost:${targetPort}/private-path` },
      ] }],
    }));

    async function restartApp() {
      await app?.stop();
      app = startApp();
      statusUrl = `http://127.0.0.1:${await waitFor("app startup", app.getPort)}/`;
    }

    const page = async () => (await fetch(statusUrl, { signal: AbortSignal.timeout(1_000) })).text();
    const pageWith = (text: string) => waitFor(text, async () => {
      const html = await page();
      return html.includes(text) ? html : null;
    });
    function certificateCheckTime(html: string) {
      const checkedAt = html.match(/>cert<\/span>[\s\S]*?Last checked <time datetime="([^"]+)"/i)?.[1];
      assert.ok(checkedAt, "The certificate row should show its latest check time");
      return checkedAt;
    }

    await restartApp();
    const firstPage = await pageWith("1 certificate warning");
    assert.match(firstPage, /7 days remaining/);
    assert.match(firstPage, /Last seen/);
    assert.doesNotMatch(firstPage, /certificate problem|private-path|localhost/);
    using db = new Database(dbPath, { readonly: true });
    const certState = db.query<{
      state: string; consecutive_failures: number; certificate_observed_at: number;
      certificate_fingerprint: string; certificate_expires_at: number;
    }, []>("SELECT state, consecutive_failures, certificate_observed_at, certificate_fingerprint, certificate_expires_at FROM state WHERE check_id = 'fixture/cert'");
    const samples = db.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM checks WHERE check_id = ?",
    );
    const events = db.query("SELECT check_id, kind FROM events ORDER BY id");
    const initial = certState.get()!;
    const webBefore = samples.get("fixture/web")!.count;
    await Bun.sleep(500);
    assert.ok(samples.get("fixture/web")!.count >= webBefore + 3);
    assert.equal(samples.get("fixture/cert")!.count, 1);
    assert.deepEqual(events.all(), []);

    await tlsTarget.close();
    tlsTarget = undefined;
    bareTarget = Bun.listen({ hostname: "127.0.0.1", port: targetPort, socket: { data() {} } });
    let previousCheck = certificateCheckTime(firstPage);
    for (let failures = 1; failures <= 3; failures++) {
      await restartApp();
      const stalePage = await waitFor(`TLS sample after timeout ${failures}`, async () => {
        const html = await page();
        return certificateCheckTime(html) !== previousCheck ? html : null;
      });
      previousCheck = certificateCheckTime(stalePage);
      assert.match(stalePage, /Latest probe did not observe a certificate\./);
      assert.equal(samples.get("fixture/cert")!.count, failures + 1);
      const stale = certState.get()!;
      assert.equal(stale.certificate_observed_at, initial.certificate_observed_at);
      assert.equal(stale.certificate_fingerprint, initial.certificate_fingerprint);
      assert.equal(stale.state, failures < 3 ? "up" : "down");
      assert.equal(stale.consecutive_failures, failures);
      assert.doesNotMatch(stalePage, /certificate warning|service check failing/);
      assert.match(stalePage, /Observed certificate expiry/);
    }
    assert.deepEqual(events.all(), [{ check_id: "fixture/cert", kind: "down" }]);

    bareTarget.stop(true);
    bareTarget = undefined;
    tlsTarget = await listenTls(key, renewed, targetPort);
    await restartApp();
    await pageWith("All checks passing");
    assert.notEqual(certState.get()!.certificate_fingerprint, initial.certificate_fingerprint);
    assert.deepEqual(events.all(), [
      { check_id: "fixture/cert", kind: "down" },
      { check_id: "fixture/cert", kind: "recovered" },
    ]);

    await tlsTarget.close();
    tlsTarget = undefined;
    tlsTarget = await listenTls(key, wrong, targetPort);
    await restartApp();
    const problem = await pageWith("1 certificate problem");
    assert.match(problem, /Fixture · cert \(TLS\)/);
    assert.match(problem, /Observed certificate expiry/);
    assert.doesNotMatch(problem, /certificate warning|service check failing|wrong\.test/);
    assert.equal(certState.get()!.consecutive_failures, 1);
    assert.deepEqual(events.all(), [
      { check_id: "fixture/cert", kind: "down" },
      { check_id: "fixture/cert", kind: "recovered" },
      { check_id: "fixture/cert", kind: "down" },
    ]);
  } finally {
    await app?.stop();
    await tlsTarget?.close();
    bareTarget?.stop(true);
    await web.stop(true);
  }
  console.log("TLS core flow and expiry display smoke checks passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
