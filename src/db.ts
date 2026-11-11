import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  applyOutcome,
  initialState,
  type CheckState,
  type ProbeOutcome,
  type StateEvent,
  type StateResult,
} from "./state";

const githubUnavailableReasons = [
  "timeout",
  "rate_limit",
  "permission",
  "network",
  "invalid_response",
  "http_error",
] as const;

export type GitHubUnavailableReason = (typeof githubUnavailableReasons)[number];
export type DiscordDeliveryOutcome = "accepted" | "rejected" | "unconfirmed";

const certificateFingerprint = /^[a-f0-9]{64}$/i;
const deliveryColumn = `
  delivery_status TEXT CHECK (
    delivery_status IN ('pending', 'accepted', 'rejected', 'unconfirmed')
  )
`;

export interface ProbeResultDetails {
  githubUnavailableReason?: GitHubUnavailableReason;
  certificate?: {
    fingerprint: string;
    expiresAt: number;
  };
}

export interface CheckSummary extends CheckState {
  lastConfirmedAt: number | null;
  repoNotice: GitHubUnavailableReason | "no_ci" | null;
  certificateExpiresAt: number | null;
  certificateObservedAt: number | null;
  uptime24h: number | null;
  uptime7d: number | null;
}

export interface OutageEvent {
  checkId: string;
  ts: number;
  kind: StateEvent["kind"];
  error: StateEvent["error"];
}

const dayMs = 24 * 60 * 60 * 1000;

const schema = `
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY,
    check_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER CHECK (ok IN (0, 1)),
    latency_ms INTEGER,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS checks_by_check_and_time ON checks (check_id, ts);
  CREATE INDEX IF NOT EXISTS checks_by_time ON checks (ts);

  CREATE TABLE IF NOT EXISTS state (
    check_id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('up', 'down', 'unknown')),
    consecutive_failures INTEGER NOT NULL,
    since INTEGER,
    last_check_at INTEGER,
    last_error TEXT,
    last_confirmed_at INTEGER,
    repo_notice TEXT CHECK (repo_notice IN (
      'no_ci', ${githubUnavailableReasons.map((reason) => `'${reason}'`).join(", ")}
    )),
    certificate_fingerprint TEXT,
    certificate_expires_at INTEGER,
    certificate_observed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    check_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('down', 'recovered', 'certificate_expiring')),
    error TEXT,
    certificate_fingerprint TEXT,
    ${deliveryColumn},
    CHECK ((kind = 'certificate_expiring') = (certificate_fingerprint IS NOT NULL))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS events_certificate_warning_once
    ON events (check_id, certificate_fingerprint)
    WHERE kind = 'certificate_expiring';

  CREATE INDEX IF NOT EXISTS events_outages_by_check_and_time
    ON events (check_id, ts DESC, id DESC)
    WHERE kind IN ('down', 'recovered');
`;

export function openDatabase(path = process.env.DB_PATH || "data/mc-status.db"): Database {
  const filename = resolve(path);
  mkdirSync(dirname(filename), { recursive: true });

  const db = new Database(filename, { create: true, strict: true });
  try {
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
      if (version?.user_version === 0) {
        const columns = db.query<{ name: string }, []>("PRAGMA table_info(events)").all();
        if (columns.some(({ name }) => name === "delivery_status")) {
          // Replace the certificate-only constraint while preserving recorded outcomes.
          db.exec(`
            ALTER TABLE events RENAME COLUMN delivery_status TO previous_delivery_status;
            ALTER TABLE events ADD COLUMN ${deliveryColumn};
            UPDATE events SET delivery_status = previous_delivery_status;
            ALTER TABLE events DROP COLUMN previous_delivery_status;
          `);
        } else if (columns.length > 0) {
          db.exec(`ALTER TABLE events ADD COLUMN ${deliveryColumn}`);
        }
        db.exec("PRAGMA user_version = 1");
      }
      db.exec(schema);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getCheckSummary(db: Database, checkId: string, at: number): CheckSummary {
  // The aggregate returns one row even when the check has no history.
  return db.query<CheckSummary, {
    checkId: string;
    at: number;
    dayStart: number;
    weekStart: number;
  }>(`
    WITH uptime AS (
      SELECT AVG(CASE WHEN ts >= $dayStart THEN ok END) * 100 AS uptime24h,
        AVG(ok) * 100 AS uptime7d
      FROM checks
      WHERE check_id = $checkId AND ts BETWEEN $weekStart AND $at
    )
    SELECT $checkId AS checkId,
      COALESCE(state.state, 'unknown') AS state,
      COALESCE(state.consecutive_failures, 0) AS consecutiveFailures,
      state.since,
      state.last_check_at AS lastCheckAt,
      state.last_error AS lastError,
      state.last_confirmed_at AS lastConfirmedAt,
      state.repo_notice AS repoNotice,
      state.certificate_expires_at AS certificateExpiresAt,
      state.certificate_observed_at AS certificateObservedAt,
      uptime.uptime24h,
      uptime.uptime7d
    FROM uptime
    LEFT JOIN state ON state.check_id = $checkId
  `).get({ checkId, at, dayStart: at - dayMs, weekStart: at - 7 * dayMs })!;
}

export function getRecentOutages(
  db: Database,
  activeCheckIds: readonly string[],
): OutageEvent[] {
  return db.query<OutageEvent, [string]>(`
    SELECT check_id AS checkId, ts, kind, error
    FROM events
    WHERE kind IN ('down', 'recovered')
      AND check_id IN (SELECT value FROM json_each(?))
    ORDER BY ts DESC, id DESC
    LIMIT 20
  `).all(JSON.stringify(activeCheckIds));
}

export function deleteExpiredSamples(db: Database, at: number): number {
  const cutoff = at - 30 * dayMs;
  return db.query("DELETE FROM checks WHERE ts < ?").run(cutoff).changes;
}

export function recordProbeResult(
  db: Database,
  checkId: string,
  outcome: ProbeOutcome,
  at: number,
  latencyMs: number | null = null,
  details?: ProbeResultDetails,
): StateResult & { eventId: number | null } {
  let repoNotice: GitHubUnavailableReason | "no_ci" | null = null;
  if (outcome.kind === "unavailable") {
    if (outcome.reason === "no_ci") repoNotice = "no_ci";
    if (outcome.reason === "github_unavailable") {
      const reason = details?.githubUnavailableReason;
      if (!reason || !githubUnavailableReasons.includes(reason)) {
        throw new Error("A safe reason is required for GitHub unavailability.");
      }
      repoNotice = reason;
    }
  }

  const certificate = outcome.type === "tls" ? details?.certificate : undefined;
  if (certificate && (
    !certificateFingerprint.test(certificate.fingerprint) ||
    !Number.isSafeInteger(certificate.expiresAt)
  )) {
    throw new Error("Invalid TLS certificate observation.");
  }

  return db.transaction(() => {
    const previous = db.query<CheckState, [string]>(`
      SELECT check_id AS checkId, state, consecutive_failures AS consecutiveFailures,
        since, last_check_at AS lastCheckAt, last_error AS lastError
      FROM state
      WHERE check_id = ?
    `).get(checkId) ?? initialState(checkId);

    const result = applyOutcome(previous, outcome, at);
    const { next, sample, event } = result;
    db.query(`
      INSERT INTO checks (check_id, ts, ok, latency_ms, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      checkId,
      at,
      sample === null ? null : Number(sample),
      latencyMs,
      sample === false ? next.lastError : null,
    );

    db.query(`
      INSERT INTO state (
        check_id, state, consecutive_failures, since, last_check_at, last_error, last_confirmed_at,
        repo_notice, certificate_fingerprint, certificate_expires_at, certificate_observed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (check_id) DO UPDATE SET
        state = excluded.state,
        consecutive_failures = excluded.consecutive_failures,
        since = excluded.since,
        last_check_at = excluded.last_check_at,
        last_error = excluded.last_error,
        last_confirmed_at = COALESCE(excluded.last_confirmed_at, state.last_confirmed_at),
        repo_notice = excluded.repo_notice,
        certificate_fingerprint = COALESCE(excluded.certificate_fingerprint, state.certificate_fingerprint),
        certificate_expires_at = COALESCE(excluded.certificate_expires_at, state.certificate_expires_at),
        certificate_observed_at = COALESCE(excluded.certificate_observed_at, state.certificate_observed_at)
    `).run(
      checkId,
      next.state,
      next.consecutiveFailures,
      next.since,
      at,
      next.lastError,
      sample === null ? null : at,
      repoNotice,
      certificate?.fingerprint.toLowerCase() ?? null,
      certificate?.expiresAt ?? null,
      certificate ? at : null,
    );

    const savedEvent = event
      ? db.query<{ id: number }, [string, number, StateEvent["kind"], StateEvent["error"]]>(`
        INSERT INTO events (check_id, ts, kind, error)
        VALUES (?, ?, ?, ?)
        RETURNING id
      `).get(checkId, at, event.kind, event.error)
      : null;

    return { ...result, eventId: savedEvent?.id ?? null };
  }).immediate();
}

export function recordCertificateWarningAttempt(
  db: Database,
  checkId: string,
  fingerprint: string,
  at: number,
): number | null {
  if (!certificateFingerprint.test(fingerprint)) {
    throw new Error("Invalid TLS certificate fingerprint.");
  }

  const attempt = db.query<{ id: number }, [string, number, string]>(`
    INSERT INTO events (check_id, ts, kind, certificate_fingerprint, delivery_status)
    VALUES (?, ?, 'certificate_expiring', ?, 'pending')
    ON CONFLICT (check_id, certificate_fingerprint) WHERE kind = 'certificate_expiring'
    DO NOTHING
    RETURNING id
  `).get(checkId, at, fingerprint.toLowerCase());

  return attempt?.id ?? null;
}

export function recordOutageDeliveryAttempt(db: Database, eventId: number): boolean {
  const result = db.query(`
    UPDATE events
    SET delivery_status = 'pending'
    WHERE id = ? AND kind IN ('down', 'recovered') AND delivery_status IS NULL
  `).run(eventId);

  return result.changes === 1;
}

export function recordDiscordDelivery(
  db: Database,
  eventId: number,
  delivery: DiscordDeliveryOutcome,
): boolean {
  const result = db.query(`
    UPDATE events
    SET delivery_status = ?
    WHERE id = ? AND delivery_status = 'pending'
  `).run(delivery, eventId);

  return result.changes === 1;
}
