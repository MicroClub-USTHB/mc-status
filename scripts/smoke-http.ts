import assert from "node:assert/strict";
import { probeHttp } from "../src/probes/http";

const streamClosed = Promise.withResolvers<void>();
let slowRedirectFollowed = false;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(request.method, "GET");
    switch (new URL(request.url).pathname) {
      case "/ok":
        return new Response(null, { status: 204 });
      case "/unavailable":
        return new Response("Private response body", {
          status: 503,
          headers: { "X-Private-Diagnostic": "private value" },
        });
      case "/redirect":
        return new Response(null, { status: 302, headers: { Location: "/ok" } });
      case "/slow-redirect":
        await Bun.sleep(200);
        return new Response(null, { status: 302, headers: { Location: "/slow-final" } });
      case "/slow-final":
        slowRedirectFollowed = true;
        await Bun.sleep(200);
        return new Response(null, { status: 204 });
      case "/stream":
        request.signal.addEventListener("abort", () => streamClosed.resolve(), { once: true });
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first chunk"));
          },
          cancel() {
            streamClosed.resolve();
          },
        }));
      case "/slow":
        await Bun.sleep(300);
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 404 });
    }
  },
});

const target = (path: string) => new URL(path, server.url).href;
const stoppedTarget = target("/ok");
const success = { type: "http", kind: "success" };

try {
  const ok = await probeHttp(target("/ok"), 2_000);
  assert.deepEqual(ok.outcome, success);
  assert.equal(ok.status, 204);
  assert.ok(Number.isInteger(ok.latencyMs) && ok.latencyMs >= 0);

  const unavailable = await probeHttp(target("/unavailable?private=query"), 2_000);
  assert.deepEqual(unavailable, {
    outcome: { type: "http", kind: "failure", reason: "response" },
    latencyMs: unavailable.latencyMs,
    status: 503,
  });

  const redirected = await probeHttp(target("/redirect"), 2_000);
  assert.deepEqual(redirected.outcome, success);
  assert.equal(redirected.status, 204);

  const slow = await probeHttp(target("/slow"), 50);
  assert.deepEqual(slow.outcome, { type: "http", kind: "failure", reason: "timeout" });
  assert.equal(slow.status, undefined);

  const slowRedirect = await probeHttp(target("/slow-redirect"), 350);
  assert.equal(slowRedirectFollowed, true);
  assert.deepEqual(slowRedirect.outcome, slow.outcome);

  const stream = await probeHttp(target("/stream"), 2_000);
  assert.deepEqual(stream.outcome, success);
  assert.equal(stream.status, 200);
  const streamReleased = await Promise.race([
    streamClosed.promise.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  assert.equal(streamReleased, true, "The unread response stream should close before the probe deadline");
} finally {
  await server.stop(true);
}

const stopped = await probeHttp(stoppedTarget, 2_000);
assert.deepEqual(stopped.outcome, { type: "http", kind: "failure", reason: "connection" });
assert.equal(stopped.status, undefined);
console.log("HTTP probe smoke checks passed.");
