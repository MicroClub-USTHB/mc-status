import { renderToStaticMarkup } from "react-dom/server";
import {
  Activity, ArrowDown, ArrowUp, Check, CircleMinus, Clock3, GitBranch,
  Layers3, Minus, Network, TriangleAlert, X,
} from "lucide-react";
import type { CheckType, ProjectGroup } from "../config";
import type { CheckSummary, GitHubUnavailableReason, OutageEvent } from "../db";
import { formatStatusAge } from "./status-time";

// Link previews need absolute URLs. PUBLIC_URL overrides the default for another deployment.
const siteUrl = (process.env.PUBLIC_URL?.trim() || "https://status.164-68-103-224.sslip.io").replace(/\/+$/, "");
const siteDescription = "Live uptime checks, outage history and CI status for the Micro Club projects.";

interface StatusProject {
  id: string;
  name: string;
  group: ProjectGroup;
  checks: { id: string; type: CheckType; summary: CheckSummary }[];
}

type StatusOutage = OutageEvent & { projectName: string; checkLabel: string; type: CheckType };

const typeLabels: Record<CheckType, string> = {
  http: "HTTP",
  tcp: "TCP",
  dns: "DNS",
  tls: "TLS",
  repo: "CI",
};
const groupIcons = { Core: Layers3, Infra: Network, Repos: GitBranch };
const signals = {
  up: { label: "Up", icon: Check },
  down: { label: "Down", icon: X },
  warning: { label: "Warning", icon: TriangleAlert },
  unknown: { label: "Unknown", icon: Minus },
} as const;
type Signal = keyof typeof signals;
type StatusCheck = StatusProject["checks"][number];
const githubNoticeLabels: Record<GitHubUnavailableReason, string> = {
  timeout: "Request timed out",
  rate_limit: "Rate limited",
  permission: "Access denied or repository unavailable",
  network: "Connection failed",
  invalid_response: "Invalid response",
  http_error: "API request failed",
};
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
const certificateDate = new Intl.DateTimeFormat("en", {
  dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
});
const dayMs = 24 * 60 * 60 * 1_000;

function formatUptime(value: number | null): string {
  if (value === null) return "n/a";
  if (value > 0 && value < 0.1) return "<0.1%";
  if (value < 100 && value > 99.9) return ">99.9%";
  return percent.format(value / 100);
}

function StatusTime({ at, now }: { at: number; now: number }) {
  const ageMs = Math.max(0, now - at);
  const timestamp = new Date(at).toISOString();
  return <time dateTime={timestamp} title={timestamp} data-age-ms={ageMs}>{formatStatusAge(ageMs)}</time>;
}

function certificateIsExpiring(summary: CheckSummary, now: number): boolean {
  return summary.state === "up" && summary.lastError === null &&
    summary.certificateObservedAt !== null && summary.certificateObservedAt === summary.lastCheckAt &&
    summary.certificateExpiresAt !== null &&
    now < summary.certificateExpiresAt && summary.certificateExpiresAt - now <= 14 * dayMs;
}

function CertificateDetails({ summary, now }: { summary: CheckSummary; now: number }) {
  const { certificateExpiresAt: expiresAt, certificateObservedAt: observedAt } = summary;
  if (expiresAt === null || observedAt === null) {
    return <p>Certificate details unavailable</p>;
  }

  const daysLeft = Math.ceil((expiresAt - now) / dayMs);
  return (
    <>
      {certificateIsExpiring(summary, now) && (
        <p className="check-notice">
          <TriangleAlert size={15} aria-hidden="true" />
          <strong>Certificate expires soon</strong>
        </p>
      )}
      <p>
        Observed certificate expiry{" "}
        <time dateTime={new Date(expiresAt).toISOString()}>{certificateDate.format(expiresAt)} UTC</time>
        {" · "}
        {expiresAt > now ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining` : "Expiry date passed"}
        {" · Last seen "}
        <StatusTime at={observedAt} now={now} />
      </p>
      {observedAt !== summary.lastCheckAt && <p>Latest probe did not observe a certificate.</p>}
    </>
  );
}

function GitHubDetails({ summary, now }: { summary: CheckSummary; now: number }) {
  const { repoNotice, state, lastCheckAt, lastConfirmedAt } = summary;
  if (repoNotice === "no_ci") {
    return <p>No CI runs on the default branch</p>;
  }

  return (
    <>
      {repoNotice && (
        <p className="check-notice">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>
            GitHub check unavailable · {githubNoticeLabels[repoNotice]}
            {lastCheckAt !== null && <> · <StatusTime at={lastCheckAt} now={now} /></>}
          </span>
        </p>
      )}
      {state !== "unknown" && lastConfirmedAt !== null && (
        <p>
          Last confirmed {state === "up" ? "passing" : "failing"}{" "}
          <StatusTime at={lastConfirmedAt} now={now} />
        </p>
      )}
    </>
  );
}

type SummaryTone = "healthy" | "failure" | "warning" | "neutral";
type SummaryItem = { label: string; tone: SummaryTone };

function getSummary(checks: readonly StatusCheck[], now: number) {
  const issues: SummaryItem[] = [];
  if (checks.length === 0) {
    return { label: "No checks configured", tone: "neutral", issues } as const;
  }

  const down = checks.filter(({ summary }) => summary.state === "down");
  const serviceDown = down.filter(({ type }) => type === "http" || type === "tcp").length;
  const ciDown = down.filter(({ type }) => type === "repo").length;
  const dnsDown = down.filter(({ type }) => type === "dns").length;
  const certificateProblems = down.filter(({ type }) => type === "tls").length;
  const certificateWarnings = checks.filter(({ type, summary }) =>
    type === "tls" && certificateIsExpiring(summary, now),
  ).length;
  const unknown = checks.filter(({ summary }) => summary.state === "unknown").length;
  const recentFailures = checks.filter(({ type, summary }) =>
    type !== "repo" && summary.state === "up" && summary.lastError,
  ).length;
  const unavailable = checks.filter(({ type, summary }) => type === "repo" && githubIsUnavailable(summary)).length;

  if (serviceDown) {
    issues.push({ label: `${serviceDown} service check${serviceDown === 1 ? "" : "s"} failing`, tone: "failure" });
  }
  if (ciDown) issues.push({ label: `${ciDown} CI check${ciDown === 1 ? "" : "s"} failing`, tone: "failure" });
  if (dnsDown) issues.push({ label: `${dnsDown} DNS check${dnsDown === 1 ? "" : "s"} failing`, tone: "failure" });
  if (certificateProblems) {
    issues.push({ label: `${certificateProblems} certificate problem${certificateProblems === 1 ? "" : "s"}`, tone: "failure" });
  }
  if (certificateWarnings) {
    issues.push({ label: `${certificateWarnings} certificate warning${certificateWarnings === 1 ? "" : "s"}`, tone: "warning" });
  }
  if (unavailable && down.length > 0) {
    issues.push({
      label: `${unavailable} check${unavailable === 1 ? "" : "s"} unavailable`,
      tone: "warning",
    });
  }
  if (recentFailures) {
    issues.push({
      label: `${recentFailures} check${recentFailures === 1 ? "" : "s"} with a failed last probe`,
      tone: "warning",
    });
  }
  if (unknown) {
    issues.push({ label: `${unknown} check${unknown === 1 ? "" : "s"} pending`, tone: "neutral" });
  }
  if (unavailable && down.length === 0) {
    return { label: "No confirmed failures. Some checks unavailable", tone: "warning", issues } as const;
  }
  if (issues.length > 0) {
    const tone = issues[0]!.tone;
    return { label: tone === "neutral" ? "Checks pending" : "Checks need attention", tone, issues };
  }

  const olderCiResult = checks.some(({ type, summary }) =>
    type === "repo" && summary.lastCheckAt !== summary.lastConfirmedAt,
  );
  return {
    label: olderCiResult ? "All checks passing at last confirmation" : "All checks passing",
    tone: "healthy",
    issues,
  } as const;
}

function githubIsUnavailable(summary: CheckSummary): boolean {
  return summary.repoNotice !== null && summary.repoNotice !== "no_ci";
}

function getSignal({ type, summary }: StatusCheck, now: number): Signal {
  if (summary.state === "down") return "down";
  if (type === "repo" && githubIsUnavailable(summary)) return "warning";
  if (type === "tls" && certificateIsExpiring(summary, now)) return "warning";
  if (summary.state === "up" && summary.lastError !== null) return "warning";
  return summary.state;
}

type StatusGroup = { name: ProjectGroup; projects: StatusProject[] };

function CheckMap({ groups, now }: { groups: readonly StatusGroup[]; now: number }) {
  const rows = groups.map(({ name, projects }) => ({
    name,
    tiles: projects.flatMap(({ name: project, id, checks }) =>
      checks.map((check) => ({
        key: `${id}/${check.id}`,
        label: `${project} · ${check.id} (${typeLabels[check.type]})`,
        signal: getSignal(check, now),
      })),
    ),
  }));
  const usedSignals = new Set(rows.flatMap(({ tiles }) => tiles.map(({ signal }) => signal)));
  const legend = (Object.keys(signals) as Signal[]).filter((signal) => usedSignals.has(signal));

  return (
    <nav className="check-map" aria-labelledby="map-title">
      <h2 id="map-title">Check map</h2>
      <ul className="map-groups">
        {rows.map(({ name, tiles }) => (
          <li key={name}>
            <a className="map-group" href={`#group-${name}`}>
              <span className="map-name">{name}</span>
              <span className="map-tiles" aria-hidden="true">
                {tiles.map(({ key, label, signal }) => {
                  const Icon = signals[signal].icon;
                  return (
                    <span className="map-tile" data-signal={signal} key={key} title={`${label} · ${signals[signal].label}`}>
                      <Icon size={15} strokeWidth={2.5} />
                    </span>
                  );
                })}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <ul className="map-legend" aria-label="Check map legend">
        {legend.map((signal) => {
          const { icon: Icon, label } = signals[signal];
          return (
            <li data-signal={signal} key={signal}>
              <Icon size={13} strokeWidth={2.5} aria-hidden="true" />
              {label}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function StatusOverview({ groups, now }: { groups: readonly StatusGroup[]; now: number }) {
  const checks = groups.flatMap(({ projects }) => projects.flatMap((project) => project.checks));
  const { label, tone, issues } = getSummary(checks, now);
  const Icon = tone === "healthy" ? Check : tone === "failure" ? Activity
    : tone === "warning" ? TriangleAlert : CircleMinus;

  return (
    <section className="overview" data-empty={checks.length === 0} aria-labelledby="page-title">
      <div className="overview-summary" data-tone={tone}>
        <span className="overview-icon"><Icon size={23} aria-hidden="true" /></span>
        <h1 id="page-title">{label}</h1>
        {issues.length > 0 && (
          <ul className="overview-issues">
            {issues.map((issue) => <li data-tone={issue.tone} key={issue.label}>{issue.label}</li>)}
          </ul>
        )}
        {checks.length === 0 && <p>Add an address to <code>targets.yaml</code> and restart the monitor.</p>}
      </div>
      {checks.length > 0 && <CheckMap groups={groups} now={now} />}
    </section>
  );
}

export function renderStatusPage(
  projects: readonly StatusProject[],
  outages: readonly StatusOutage[],
  now: number,
): string {
  const groupOrder: readonly ProjectGroup[] = ["Core", "Infra", "Repos"];
  const groups = groupOrder.map((name) => ({
    name, projects: projects.filter(({ group }) => group === name),
  })).filter((group) => group.projects.length > 0);

  return "<!doctype html>" + renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta httpEquiv="refresh" content="60" />
        <meta name="theme-color" content="#eef1fa" />
        <title>Micro Club Status</title>
        <meta name="description" content={siteDescription} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Micro Club" />
        <meta property="og:title" content="Micro Club Status" />
        <meta property="og:description" content={siteDescription} />
        <meta property="og:url" content={`${siteUrl}/`} />
        <meta property="og:image" content={`${siteUrl}/assets/og-image.png`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="The Micro Club status page: all checks passing, next to the headline Micro Club, live status." />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Micro Club Status" />
        <meta name="twitter:description" content={siteDescription} />
        <meta name="twitter:image" content={`${siteUrl}/assets/og-image.png`} />
        <link rel="icon" type="image/png" href="/assets/favicon.png" />
        <link rel="stylesheet" href="/assets/status.css" />
        {projects.length > 0 && <script src="/assets/status-clock.js" defer />}
      </head>
      <body>
        <a className="skip-link" href="#main">Skip to status</a>
        <header className="site-header">
          <div className="page-width header-content">
            <div className="brand">
              <img src="/assets/favicon.png" alt="" width={36} height={36} />
              <span>Micro Club <span className="brand-section">Status</span></span>
            </div>
            {projects.length > 0 && (
              <nav className="site-nav" aria-label="Status page">
                <a href="#checks">Checks</a>
                <a href="#outages">Recent outages</a>
              </nav>
            )}
            <span className="refresh-note"><Clock3 size={16} aria-hidden="true" /> Refreshes every 60s</span>
          </div>
        </header>
        <main className="page-width status-page" id="main" tabIndex={-1}>
          <StatusOverview groups={groups} now={now} />
          {groups.length > 0 && (
            <div className="status-layout">
              <section id="checks" aria-labelledby="checks-title">
                <h2 className="section-title" id="checks-title">Monitored checks</h2>
                <div className="check-board">
                  <div className="board-columns check-grid" aria-hidden="true">
                    <span>Check</span>
                    <span>Status</span>
                    <div className="check-metrics">
                      <span>Last checked</span><span>24h uptime</span><span>7d uptime</span>
                    </div>
                  </div>
                  {groups.map((group) => <CheckGroup group={group} now={now} key={group.name} />)}
                </div>
              </section>
              <OutageTimeline outages={outages} now={now} />
            </div>
          )}
        </main>
      </body>
    </html>,
  );
}

function CheckGroup({ group, now }: { group: StatusGroup; now: number }) {
  const { name, projects } = group;
  const Icon = groupIcons[name];

  return (
    <section className="check-group" aria-labelledby={`group-${name}`}>
      <h3 className="group-title" id={`group-${name}`}>
        <Icon size={18} aria-hidden="true" /> {name}
      </h3>
      {projects.map(({ id, name, checks }) => (
        <div className="project" key={id}>
          <h4 className="project-title">{name}</h4>
          <ul className="check-list" aria-label={`${name} checks`}>
            {checks.map((check) => <CheckRow key={check.id} check={check} now={now} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

function CheckRow({ check, now }: { check: StatusCheck; now: number }) {
  const { id, type, summary } = check;
  const hasDetails = type === "repo"
    ? summary.repoNotice !== null || (summary.state !== "unknown" && summary.lastConfirmedAt !== null)
    : summary.lastError !== null || (type === "tls" && summary.lastCheckAt !== null);

  return (
    <li className="check-row check-grid">
      <div className="check-identity">
        <span className="check-name">{id}</span>
        <span className="check-type">{typeLabels[type]}</span>
      </div>
      <span className="state-badge" data-state={summary.state}>{signals[summary.state].label}</span>
      <dl className="check-metrics">
        <div>
          <dt className="metric-label">Last checked</dt>{" "}
          <dd>{summary.lastCheckAt === null ? "Awaiting first probe" : <StatusTime at={summary.lastCheckAt} now={now} />}</dd>
        </div>
        <div>
          <dt className="metric-label">24h uptime</dt>{" "}
          <dd className="uptime">{formatUptime(summary.uptime24h)}</dd>
        </div>
        <div>
          <dt className="metric-label">7d uptime</dt>{" "}
          <dd className="uptime">{formatUptime(summary.uptime7d)}</dd>
        </div>
      </dl>
      {hasDetails && (
        <div className="check-details">
          {type !== "repo" && summary.lastError && (
            <p>Last probe failed · {summary.lastError}</p>
          )}
          {type === "repo" && <GitHubDetails summary={summary} now={now} />}
          {type === "tls" && summary.lastCheckAt !== null && <CertificateDetails summary={summary} now={now} />}
        </div>
      )}
    </li>
  );
}

function OutageTimeline({ outages, now }: { outages: readonly StatusOutage[]; now: number }) {
  return (
    <section className="outage-section" id="outages" aria-labelledby="outages-title">
      <h2 className="section-title" id="outages-title">Recent outages</h2>
      {outages.length === 0 ? (
        <p className="empty-history"><Check size={17} aria-hidden="true" /> No outages recorded.</p>
      ) : (
        <ol className="timeline">
          {outages.map(({ checkId, ts, kind, projectName, checkLabel, type, error }, index) => {
            const Icon = kind === "down" ? ArrowDown : ArrowUp;
            return (
              <li className="timeline-event" data-kind={kind} key={`${checkId}/${ts}/${index}`}>
                <span className="timeline-marker"><Icon size={15} strokeWidth={2.5} aria-hidden="true" /></span>
                <div className="event-meta">
                  <strong className="event-kind">{kind === "down" ? "Down" : "Recovered"}</strong>
                  <StatusTime at={ts} now={now} />
                </div>
                <p className="event-name">{projectName} · {checkLabel} ({typeLabels[type]})</p>
                {error && <p className="event-error">{error}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
