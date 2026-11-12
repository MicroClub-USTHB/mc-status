import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { stringify } from "yaml";
import { getActiveProjects, parseTargetsYaml, type CheckType, type ProjectGroup } from "../src/config";
import { getCheckSummary, getRecentOutages, openDatabase, recordProbeResult, type ProbeResultDetails } from "../src/db";
import type { ProbeOutcome } from "../src/state";
import { pageAssets } from "../src/ui/page-assets";
import { renderStatusPage } from "../src/ui/status-page";

type Sample = { minutesAgo: number; outcome: ProbeOutcome; details?: ProbeResultDetails };
type FixtureCheck = { id: string; type: CheckType; samples: Sample[]; disabled?: true };
type FixtureProject = { name: string; group: ProjectGroup; checks: FixtureCheck[] };

const now = Date.now();
const minute = 60_000;
const day = 24 * 60 * minute;
const sample = (minutesAgo: number, outcome: ProbeOutcome, details?: ProbeResultDetails): Sample =>
  ({ minutesAgo, outcome, details });
const pass = (type: CheckType, minutesAgo: number, details?: ProbeResultDetails) =>
  sample(minutesAgo, { type, kind: "success" }, details);
const failure = (type: "http" | "tcp" | "dns" | "tls", minutesAgo: number) =>
  sample(minutesAgo, { type, kind: "failure", reason: "connection" });
const certificate = (fingerprintByte: string, days: number): ProbeResultDetails => ({
  certificate: { fingerprint: fingerprintByte.repeat(32), expiresAt: now + days * day },
});
const rateLimited = sample(2, { type: "repo", kind: "unavailable", reason: "github_unavailable" },
  { githubUnavailableReason: "rate_limit" });
const noCi = sample(3, { type: "repo", kind: "unavailable", reason: "no_ci" });

const scenarios: { path: string; title: string; projects: FixtureProject[] }[] = [
  {
    path: "/mixed", title: "Mixed results",
    projects: [
      { name: "Preview Web Service", group: "Core", checks: [
        { id: "web", type: "http", samples: [
          pass("http", 2_880), failure("http", 110), failure("http", 109),
          failure("http", 108), pass("http", 90), pass("http", 1),
        ] },
        { id: "api", type: "http", samples: [
          pass("http", 45), failure("http", 12), failure("http", 11), failure("http", 10),
        ] },
        { id: "certificate", type: "tls", samples: [pass("tls", 5, certificate("a1", 7))] },
      ] },
      { name: "Preview Network", group: "Infra", checks: [
        { id: "socket", type: "tcp", samples: [pass("tcp", 1)] },
        { id: "lookup", type: "dns", samples: [
          pass("dns", 20), failure("dns", 8), failure("dns", 7), failure("dns", 6),
        ] },
        { id: "expired-certificate", type: "tls", samples: [
          sample(14, { type: "tls", kind: "failure", reason: "invalid_certificate" }, certificate("b2", -2)),
        ] },
        { id: "stale-certificate", type: "tls", samples: [
          pass("tls", 90, certificate("c3", 10)), failure("tls", 4),
        ] },
        { id: "new-check", type: "http", samples: [] },
      ] },
      { name: "Preview CI", group: "Repos", checks: [
        { id: "build", type: "repo", samples: [
          pass("repo", 30), sample(9, { type: "repo", kind: "failure", reason: "ci_failure" }),
        ] },
        { id: "rate-limited", type: "repo", samples: [pass("repo", 22), rateLimited] },
        { id: "no-ci", type: "repo", samples: [noCi] },
      ] },
    ],
  },
  {
    path: "/healthy", title: "All checks passing",
    projects: [
      { name: "Preview Healthy Service", group: "Core", checks: [
        { id: "web", type: "http", samples: [pass("http", 1)] },
        { id: "lookup", type: "dns", samples: [pass("dns", 2)] },
        { id: "certificate", type: "tls", samples: [pass("tls", 5, certificate("d4", 40))] },
      ] },
      { name: "Preview Healthy Build", group: "Repos", checks: [
        { id: "build", type: "repo", samples: [pass("repo", 4)] },
      ] },
    ],
  },
  {
    path: "/unavailable", title: "GitHub unavailable, previous pass",
    projects: [{ name: "Preview Rate Limited Build", group: "Repos", checks: [
      { id: "build", type: "repo", samples: [pass("repo", 22), rateLimited] },
    ] }],
  },
  {
    path: "/empty", title: "No checks configured",
    projects: [{ name: "Preview Disabled Service", group: "Core", checks: [
      { id: "web", type: "http", samples: [], disabled: true },
    ] }],
  },
];

const addresses = {
  http: { url: "http://preview.fixture.invalid" },
  tcp: { url: "127.0.0.1:9000" },
  dns: { url: "preview.fixture.invalid" },
  tls: { url: "https://preview.fixture.invalid" },
  repo: { repo: "preview-fixture/example" },
};
const dataDir = resolve("data");
mkdirSync(dataDir, { recursive: true });
const fixtureDir = mkdtempSync(join(dataDir, "ui-preview-"));

const previews = new Map(scenarios.map(({ path, projects }) => {
  const directory = join(fixtureDir, path.slice(1));
  mkdirSync(directory);
  const yaml = stringify({
    interval: 60, timeout: 10,
    projects: projects.map(({ name, group, checks }) => ({
      name, group,
      checks: checks.map(({ id, type, disabled }) => ({
        id, type, ...(disabled ? { url: "" } : addresses[type]),
      })),
    })),
  });
  writeFileSync(join(directory, "targets.yaml"), "# Offline UI preview fixture\n" + yaml);
  const activeProjects = getActiveProjects(parseTargetsYaml(yaml));
  const db = openDatabase(join(directory, "status.db"));
  const labels = new Map(activeProjects.flatMap((project) => project.checks.map((check) =>
    [check.checkId, { projectName: project.name, checkLabel: check.id, type: check.type }] as const,
  )));

  for (const project of activeProjects) {
    const fixture = projects.find(({ name }) => name === project.name)!;
    for (const check of project.checks) {
      const { samples } = fixture.checks.find(({ id }) => id === check.id)!;
      for (const { minutesAgo, outcome, details } of samples) {
        recordProbeResult(db, check.checkId, outcome, now - minutesAgo * minute, 20, details);
      }
    }
  }

  return [path, { db, activeProjects, labels }] as const;
}));

const htmlHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
const menu = "<!doctype html>" + renderToStaticMarkup(
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>mc-status UI previews</title>
      <link rel="icon" type="image/png" href="/assets/favicon.png" />
      <link rel="stylesheet" href="/assets/status.css" />
    </head>
    <body>
      <main className="page-width status-page preview-menu">
        <h1>UI previews</h1>
        <nav aria-label="Preview scenarios">
          <ul>
            {scenarios.map(({ path, title }) => (
              <li key={path}><a href={path}>{title}</a></li>
            ))}
          </ul>
        </nav>
      </main>
    </body>
  </html>,
);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.method !== "GET") return new Response("Not found", { status: 404 });
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response(menu, { headers: htmlHeaders });
    const asset = pageAssets.get(pathname);
    if (asset) return new Response(asset);
    const preview = previews.get(pathname);
    if (!preview) return new Response("Not found", { status: 404 });

    const { db, activeProjects, labels } = preview;
    const renderedAt = Date.now();
    const projects = activeProjects.map(({ id, name, group, checks }) => ({
      id, name, group, checks: checks.map((check) => ({
        id: check.id, type: check.type, summary: getCheckSummary(db, check.checkId, renderedAt),
      })),
    }));
    const outages = getRecentOutages(db, [...labels.keys()]).map((event) => ({
      ...event, ...labels.get(event.checkId)!,
    }));
    return new Response(renderStatusPage(projects, outages, renderedAt), { headers: htmlHeaders });
  },
});

console.log(`UI previews: ${server.url.href}`);
console.log(`Fixture configs and databases: ${fixtureDir}`);
