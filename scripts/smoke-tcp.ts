import assert from "node:assert/strict";
import { Socket } from "node:net";
import { probeTcp } from "../src/probes/tcp";

const success = { type: "tcp", kind: "success" };
const connectionFailure = { type: "tcp", kind: "failure", reason: "connection" };

for (const host of ["127.0.0.1", "::1"]) {
  const listener = Bun.listen({
    hostname: host,
    port: 0,
    socket: { data() {} },
  });
  const address = host === "::1" ? `[${host}]:${listener.port}` : `${host}:${listener.port}`;
  try {
    const result = await probeTcp(address, 1_000);
    assert.deepEqual(result.outcome, success);
    assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
  } finally {
    listener.stop(true);
  }
  assert.deepEqual((await probeTcp(address, 1_000)).outcome, connectionFailure);
}

assert.throws(() => probeTcp("missing-port", 1_000), /Invalid TCP check address/);

// A loopback connect normally succeeds or is refused immediately. Hold it open to test the deadline.
const originalConnect = Socket.prototype.connect;
let pendingSocket: Socket | undefined;
try {
  Socket.prototype.connect = function (this: Socket) {
    pendingSocket = this;
    return this;
  };
  const timedOut = await probeTcp("127.0.0.1:12345", 25);
  assert.deepEqual(timedOut.outcome, { type: "tcp", kind: "failure", reason: "timeout" });
  assert.equal(pendingSocket?.destroyed, true);

  const socketTimeout = probeTcp("127.0.0.1:12345", 1_000);
  pendingSocket?.emit("error", Object.assign(new Error("Socket timed out"), { code: "ETIMEDOUT" }));
  assert.deepEqual((await socketTimeout).outcome, timedOut.outcome);

  const controller = new AbortController();
  const pending = probeTcp("127.0.0.1:12345", 1_000, controller.signal);
  controller.abort();
  assert.deepEqual((await pending).outcome, connectionFailure);
  assert.equal(pendingSocket?.destroyed, true);
} finally {
  Socket.prototype.connect = originalConnect;
}

console.log("TCP probe smoke checks passed.");
