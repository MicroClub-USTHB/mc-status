import { renderToStaticMarkup } from "react-dom/server";
import { History, TriangleAlert } from "lucide-react";
import type { CheckType, ProjectGroup } from "../config";
import type { CheckSummary, GitHubUnavailableReason, OutageEvent } from "../db";
import { McAlert } from "./components/mc-alert";
import { McBadge } from "./components/mc-badge";
import { McButton } from "./components/mc-button";
import { McCard, McCardContent, McCardHeader } from "./components/mc-card";
import { McSeparator } from "./components/mc-separator";
import { formatStatusAge } from "./status-time";

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
const stateBadges = {
  up: { label: "Up", variant: "default" },
  down: { label: "Down", variant: "destructive" },
  unknown: { label: "Unknown", variant: "outline" },
} as const;
const successBadgeStyle = "border-success/40 bg-success-foreground text-foreground";
const focusStyle = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
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
        <p>
          <McBadge
            variant="outline"
            className="border-warning/40 bg-warning-foreground text-orange-600"
            icon={<TriangleAlert aria-hidden="true" />}
          >
            Certificate expires soon
          </McBadge>
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
        <p className="flex items-start gap-2">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orange-600" />
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

type SummaryItem = { label: string; tone: "healthy" | "failure" | "warning" | "neutral" };

function getSummaryItems(projects: readonly StatusProject[], now: number): [SummaryItem, ...SummaryItem[]] {
  const checks = projects.flatMap((project) => project.checks);
  if (checks.length === 0) return [{ label: "No checks configured", tone: "neutral" }];

  const down = checks.filter(({ summary }) => summary.state === "down");
  const serviceDown = down.filter(({ type }) => type === "http" || type === "tcp").length;
  const ciDown = down.filter(({ type }) => type === "repo").length;
  const dnsDown = down.filter(({ type }) => type === "dns").length;
  const certificateProblems = down.filter(({ type }) => type === "tls").length;
  const certificateWarnings = checks.filter(({ type, summary }) =>
    type === "tls" && certificateIsExpiring(summary, now),
  ).length;
  const unconfirmed = checks.filter(({ summary }) => summary.state === "unknown").length;
  const recentFailures = checks.filter(({ type, summary }) =>
    type !== "repo" && summary.state === "up" && summary.lastError,
  ).length;
  const unavailable = checks.filter(({ type, summary }) =>
    type === "repo" && summary.repoNotice && summary.repoNotice !== "no_ci",
  ).length;
  const items: SummaryItem[] = [];
  if (serviceDown) {
    items.push({ label: `${serviceDown} service check${serviceDown === 1 ? "" : "s"} failing`, tone: "failure" });
  }
  if (ciDown) items.push({ label: `${ciDown} CI check${ciDown === 1 ? "" : "s"} failing`, tone: "failure" });
  if (dnsDown) items.push({ label: `${dnsDown} DNS check${dnsDown === 1 ? "" : "s"} failing`, tone: "failure" });
  if (certificateProblems) {
    items.push({ label: `${certificateProblems} certificate problem${certificateProblems === 1 ? "" : "s"}`, tone: "failure" });
  }
  if (certificateWarnings) {
    items.push({ label: `${certificateWarnings} certificate warning${certificateWarnings === 1 ? "" : "s"}`, tone: "warning" });
  }
  if (unavailable) {
    items.push({
      label: down.length === 0 ? "No confirmed failures; some checks unavailable"
        : `${unavailable} check${unavailable === 1 ? "" : "s"} unavailable`,
      tone: "warning",
    });
  }
  if (unconfirmed) {
    items.push({
      label: unconfirmed === 1
        ? "1 check has no confirmed status yet"
        : `${unconfirmed} checks have no confirmed status yet`,
      tone: "neutral",
    });
  }
  if (recentFailures) {
    items.push({
      label: `${recentFailures} check${recentFailures === 1 ? "" : "s"} with a failed last probe`,
      tone: "warning",
    });
  }
  const [firstIssue, ...otherIssues] = items;
  if (firstIssue) return [firstIssue, ...otherIssues];
  const olderCiResult = checks.some(({ type, summary }) =>
    type === "repo" && summary.lastCheckAt !== summary.lastConfirmedAt,
  );
  return [{
    label: olderCiResult ? "All checks passing at last confirmation" : "All checks passing",
    tone: "healthy",
  }];
}

export function renderStatusPage(
  projects: readonly StatusProject[],
  outages: readonly StatusOutage[],
  now: number,
): string {
  const groups = new Set(projects.map(({ group }) => group));
  const [summary, ...otherIssues] = getSummaryItems(projects, now);
  const summaryVariant = summary.tone === "healthy" ? "success"
    : summary.tone === "failure" ? "destructive" : "default";
  return "<!doctype html>" + renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta httpEquiv="refresh" content="60" />
        <title>Micro Club Status</title>
        <link rel="icon" type="image/png" href="/assets/favicon.png" />
        <link rel="stylesheet" href="/assets/status.css" />
        {projects.length > 0 && <script src="/assets/status-clock.js" defer />}
      </head>
      <body className="min-h-screen bg-surface text-surface-foreground">
        <header className="border-b border-border bg-background">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-6">
            <span className="header-xs flex items-center gap-2 font-bold">
              <img src="/assets/favicon.png" alt="" width={32} height={32} className="shrink-0 rounded-sm" />
              Micro Club
            </span>
            {projects.length > 0 && (
              <nav className="flex flex-wrap gap-1" aria-label="Status page">
                <McButton size="sm" variant="tertiary" nativeButton={false} className={focusStyle}
                  render={<a href="#checks" />}>
                  Checks
                </McButton>
                <McButton size="sm" variant="tertiary" nativeButton={false} className={focusStyle}
                  render={<a href="#outages" />}>
                  Recent outages
                </McButton>
              </nav>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6 sm:py-12">
          <section className="space-y-4" aria-labelledby="page-title">
            <h1 className="header-md sm:header-lg font-bold" id="page-title">System status</h1>
            <McAlert
              variant={summaryVariant}
              title={summary.label}
              items={otherIssues.map(({ label }) => label)}
              className="w-full max-w-none bg-card [&[data-variant=success]_span]:text-card-foreground [&_li]:text-card-foreground sm:[&_ul]:grid sm:[&_ul]:grid-cols-2 sm:[&_ul]:gap-x-8"
            />
          </section>
          {projects.length > 0 && (
            <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <section className="min-w-0 space-y-6" id="checks" aria-label="Checks">
                {[...groups].map((group) => (
                  <section className="space-y-3" aria-labelledby={`group-${group}`} key={group}>
                    <h2 className="header-xs font-bold" id={`group-${group}`}>{group}</h2>
                    {projects.filter((project) => project.group === group).map(({ id, name, checks }) => (
                      <McCard className="gap-0 pb-0" key={id}>
                        <McCardHeader className="pb-3 [&_h3]:header-xs [&_h3]:wrap-anywhere" title={name} />
                        <McSeparator className="border-0 bg-border" />
                        <McCardContent>
                          <ul className="divide-y divide-border" aria-label={`${name} checks`}>
                            {checks.map((check) => <CheckRow key={check.id} check={check} now={now} />)}
                          </ul>
                        </McCardContent>
                      </McCard>
                    ))}
                  </section>
                ))}
              </section>
              <section className="min-w-0 space-y-3" id="outages" aria-labelledby="outages-title">
                <h2 className="header-xs flex items-center gap-2 font-bold" id="outages-title">
                  <History aria-hidden="true" className="size-5 shrink-0 text-primary" />
                  Recent outages
                </h2>
                <McCard>
                  <McCardContent>
                    {outages.length === 0 ? (
                      <p className="paragraph-sm text-muted-foreground">No outages recorded.</p>
                    ) : (
                      <ol className="divide-y divide-border">
                        {outages.map(({ checkId, ts, kind, projectName, checkLabel, type, error }, index) => (
                          <li className="space-y-1 py-3 first:pt-0 last:pb-0" key={`${checkId}/${ts}/${index}`}>
                            <div className="paragraph-xs flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                              <McBadge
                                className={kind === "recovered" ? successBadgeStyle : undefined}
                                variant={kind === "down" ? "destructive" : "default"}
                              >
                                {kind === "down" ? "Down" : "Recovered"}
                              </McBadge>
                              <StatusTime at={ts} now={now} />
                            </div>
                            <p className="paragraph-sm wrap-anywhere font-medium">
                              {projectName} · {checkLabel} ({typeLabels[type]})
                            </p>
                            {error && <p className="paragraph-xs text-muted-foreground">{error}</p>}
                          </li>
                        ))}
                      </ol>
                    )}
                  </McCardContent>
                </McCard>
              </section>
            </div>
          )}
        </main>
      </body>
    </html>,
  );
}

function CheckRow({ check, now }: { check: StatusProject["checks"][number]; now: number }) {
  const { id, type, summary } = check;
  const badge = stateBadges[summary.state];
  const hasDetails = type === "repo"
    ? summary.repoNotice !== null || (summary.state !== "unknown" && summary.lastConfirmedAt !== null)
    : summary.lastError !== null || (type === "tls" && summary.lastCheckAt !== null);

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 py-4 sm:grid-cols-[minmax(0,1fr)_9rem_4.5rem]">
      <div className="min-w-0">
        <div className="paragraph-sm flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
          <span className="min-w-0 wrap-anywhere">{id}</span>
          <McBadge variant="secondary">{typeLabels[type]}</McBadge>
        </div>
        <p className="paragraph-xs mt-1 text-muted-foreground">
          {summary.lastCheckAt !== null
            ? <>Last checked <StatusTime at={summary.lastCheckAt} now={now} /></>
            : "Awaiting first probe"}
        </p>
      </div>
      <div className="col-start-2 row-start-1 justify-self-end sm:col-start-3">
        <McBadge variant={badge.variant} className={summary.state === "up" ? successBadgeStyle : undefined}>
          {badge.label}
        </McBadge>
      </div>
      <dl className="col-span-full grid grid-cols-2 gap-3 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <div>
          <dt className="paragraph-xs text-muted-foreground">24h uptime</dt>{" "}
          <dd className="paragraph-sm font-semibold tabular-nums">{formatUptime(summary.uptime24h)}</dd>
        </div>
        <div>
          <dt className="paragraph-xs text-muted-foreground">7d uptime</dt>{" "}
          <dd className="paragraph-sm font-semibold tabular-nums">{formatUptime(summary.uptime7d)}</dd>
        </div>
      </dl>
      {hasDetails && (
        <div className="paragraph-xs col-span-full space-y-1 text-muted-foreground">
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
