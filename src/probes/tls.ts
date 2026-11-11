import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, connect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { ProbeOutcome } from "../state";

type TlsFailure = "connection" | "timeout" | "invalid_certificate";
type CertificateObservation = { fingerprint: string; expiresAt: number };

interface TlsProbeResult {
  outcome: ProbeOutcome;
  latencyMs: number;
  certificate?: CertificateObservation;
}

const certificateErrors = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "INVALID_CA",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export function probeTls(
  url: string,
  timeoutMs: number,
  stopSignal?: AbortSignal,
  ca?: ConnectionOptions["ca"],
): Promise<TlsProbeResult> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("Invalid TLS check address.");
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = target.port ? Number(target.port) : 443;
  const startedAt = performance.now();

  return new Promise((resolve) => {
    let socket: TLSSocket | undefined;
    let finished = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const onAbort = () => finish("connection");

    function finish(reason?: TlsFailure, certificate?: CertificateObservation) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopSignal?.removeEventListener("abort", onAbort);
      socket?.destroy();
      resolve({
        outcome: reason ? { type: "tls", kind: "failure", reason } : { type: "tls", kind: "success" },
        latencyMs: Math.round(performance.now() - startedAt),
        ...(certificate ? { certificate } : {}),
      });
    }

    if (stopSignal?.aborted) {
      onAbort();
      return;
    }
    stopSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const connection = connect({
        host,
        port,
        servername: isIP(host) ? undefined : host.replace(/\.$/, ""),
        ca,
        // Let TLS expose invalid certificates. Only an authorized peer can pass.
        rejectUnauthorized: false,
      });
      socket = connection;
      connection.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ETIMEDOUT") finish("timeout");
        else if (error.code && certificateErrors.has(error.code)) finish("invalid_certificate");
        else finish("connection");
      });
      connection.once("close", () => finish("connection"));
      connection.once("secureConnect", () => {
        try {
          const peer = connection.getPeerCertificate();
          if (!peer.raw?.length) {
            finish("connection");
            return;
          }
          const expiresAt = Date.parse(peer.valid_to);
          const validFrom = Date.parse(peer.valid_from);
          const certificate = Number.isFinite(expiresAt)
            ? { fingerprint: createHash("sha256").update(peer.raw).digest("hex"), expiresAt }
            : undefined;
          const now = Date.now();
          const valid = connection.authorized && certificate &&
            validFrom <= now && now < expiresAt && !checkServerIdentity(host, peer);
          finish(valid ? undefined : "invalid_certificate", certificate);
        } catch {
          finish("connection");
        }
      });
    } catch {
      finish("connection");
    }
  });
}
