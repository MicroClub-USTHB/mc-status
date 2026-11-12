import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubUnavailableReason } from "../src/db";
import { probeRepo } from "../src/probes/repo";
import { startServer } from "../src/server";

const repo = "private-fixture-owner/private-fixture-repo";
const branch = "release/stable";
const secret = "fixture-secret-value";
const metadataPath = `/repos/${repo}`;
const runsPath = `${metadataPath}/actions/runs`;
const nativeFetch = globalThis.fetch;
const requests: { path: string; branch: string | null; perPage: string | null; headers: Headers }[] = [];
const good = { type: "repo", kind: "success" };
const bad = { type: "repo", kind: "failure", reason: "ci_failure" };
const inconclusive = (reason: string) => ({ type: "repo", kind: "unavailable", reason });
const complete = (conclusion: string | null, date = 2) => ({
  status: "completed", conclusion, created_at: `2026-11-0${date}T00:00:00Z`,
});
const running = { ...complete(null, 4), status: "in_progress" };
const runs = (...workflow_runs: unknown[]) => Response.json({ total_count: workflow_runs.length, workflow_runs });
let metadata: () => Response | Promise<Response> = () => Response.json({ default_branch: branch });
let workflowRuns: () => Response | Promise<Response> = () => runs(complete("success"));
let rejectRequest = false;

const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    requests.push({
      path: url.pathname, branch: url.searchParams.get("branch"),
      perPage: url.searchParams.get("per_page"), headers: request.headers,
    });
    if (url.pathname === metadataPath) return metadata();
    if (url.pathname === runsPath) return workflowRuns();
    return new Response(secret, { status: 404 });
  },
});
globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
  const [input, init] = args;
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://api.github.com") return nativeFetch(...args);
  if (rejectRequest) return Promise.reject(new Error(secret));
  return nativeFetch(new URL(url.pathname + url.search, fixture.url), init);
}, nativeFetch);

async function expectUnavailable(reason: GitHubUnavailableReason, timeout = 1_000) {
  const result = await probeRepo(repo, timeout);
  assert.deepEqual(result.outcome, inconclusive("github_unavailable"));
  assert.equal(result.githubUnavailableReason, reason);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private-fixture/);
}

async function waitFor(label: string, ready: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    if (await ready()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const originalDirectory = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "mc-status-repo-"));
const dbPath = join(directory, "status.db");
let app: Awaited<ReturnType<typeof startServer>> | undefined;

try {
  process.env.GITHUB_TOKEN = ` ${secret} `;
  workflowRuns = () => runs(complete("success", 1), running, complete("failure", 3));
  assert.deepEqual((await probeRepo(repo, 1_000)).outcome, bad);
  assert.deepEqual(requests.map(({ path, branch, perPage }) => [path, branch, perPage]), [
    [metadataPath, null, null], [runsPath, branch, "5"],
  ]);
  for (const { headers } of requests) {
    assert.equal(headers.get("Authorization"), `Bearer ${secret}`);
    assert.equal(headers.get("Accept"), "application/vnd.github+json");
    assert.equal(headers.get("X-GitHub-Api-Version"), "2026-03-10");
    assert.equal(headers.get("User-Agent"), "mc-status");
  }

  process.env.GITHUB_TOKEN = "";
  workflowRuns = () => runs(running, complete("success"));
  assert.deepEqual((await probeRepo(repo, 1_000)).outcome, good);
  assert.equal(requests.at(-1)!.headers.get("Authorization"), null);
  workflowRuns = () => runs(complete("timed_out"));
  assert.deepEqual((await probeRepo(repo, 1_000)).outcome, bad);
  for (const conclusion of ["cancelled", "skipped", "neutral", "action_required", "startup_failure"]) {
    workflowRuns = () => runs(complete("failure", 1), complete(conclusion, 3));
    assert.deepEqual((await probeRepo(repo, 1_000)).outcome, inconclusive("ignored"));
  }
  workflowRuns = () => runs(running);
  assert.deepEqual((await probeRepo(repo, 1_000)).outcome, inconclusive("ignored"));
  workflowRuns = () => runs();
  assert.deepEqual((await probeRepo(repo, 1_000)).outcome, inconclusive("no_ci"));

  for (const response of [
    () => new Response(""),
    () => new Response(secret),
    () => Response.json({ workflow_runs: [] }),
    () => Response.json({ total_count: 2, workflow_runs: [] }),
    () => Response.json({ total_count: 0, workflow_runs: [complete("success")] }),
    () => runs(complete(null)),
    () => runs({ ...complete("success"), status: "bogus" }),
    () => runs({ ...complete("success"), created_at: "invalid" }),
  ]) {
    workflowRuns = response;
    await expectUnavailable("invalid_response");
  }

  metadata = () => Response.json({ default_branch: "" });
  const requestsBefore = requests.length;
  await expectUnavailable("invalid_response");
  assert.equal(requests.length, requestsBefore + 1);
  metadata = () => Response.json({ default_branch: branch });

  for (const [response, reason] of [
    [() => new Response(secret, { status: 429 }), "rate_limit"],
    [() => new Response(secret, { status: 403, headers: { "X-RateLimit-Remaining": "0" } }), "rate_limit"],
    [() => new Response(secret, { status: 403, headers: { "Retry-After": "60" } }), "rate_limit"],
    [() => Response.json({ message: "You exceeded a secondary rate limit." }, { status: 403 }), "rate_limit"],
    [() => Response.json({ message: secret }, { status: 403 }), "permission"],
    [() => new Response(secret, { status: 401 }), "permission"],
    [() => new Response(secret, { status: 404 }), "permission"],
    [() => new Response(secret, { status: 503 }), "http_error"],
    [() => new Response(null, { status: 302, headers: { Location: "/unexpected-redirect" } }), "http_error"],
  ] as const) {
    workflowRuns = response;
    await expectUnavailable(reason);
  }
  assert.ok(!requests.some(({ path }) => path === "/unexpected-redirect"));

  rejectRequest = true;
  await expectUnavailable("network");
  rejectRequest = false;

  metadata = async () => {
    await Bun.sleep(200);
    return Response.json({ default_branch: branch });
  };
  workflowRuns = async () => {
    await Bun.sleep(200);
    return runs(complete("success"));
  };
  await expectUnavailable("timeout", 350);
  assert.equal(requests.at(-1)!.path, runsPath, "The two requests share one deadline");
  metadata = () => Response.json({ default_branch: branch });

  const stop = new AbortController();
  workflowRuns = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
  }));
  const beforeAbort = requests.length;
  const pending = probeRepo(repo, 5_000, stop.signal);
  await waitFor("the stalled workflow response", () => requests.length >= beforeAbort + 2);
  stop.abort();
  assert.equal((await pending).githubUnavailableReason, "network");
  await expectUnavailable("timeout", 100);

  process.chdir(directory);
  process.env.DB_PATH = dbPath;
  process.env.GITHUB_TOKEN = secret;
  await writeFile("targets.yaml", JSON.stringify({
    interval: 0.1, timeout: 1,
    projects: [{ name: "Fixture", group: "Repos", checks: [{ id: "ci", type: "repo", repo }] }],
  }));
  let samplesSeen = 0;
  async function runCheck(response: () => Response, expectedText: string) {
    await app?.stop();
    workflowRuns = response;
    app = await startServer(0);
    using db = new Database(dbPath, { readonly: true });
    const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM checks");
    samplesSeen++;
    await waitFor("the CI sample", () => count.get()!.count === samplesSeen);
    const html = await (await nativeFetch(`http://127.0.0.1:${app.port}/`)).text();
    assert.ok(html.includes(expectedText), `Expected ${expectedText}`);
    assert.doesNotMatch(html, /private-fixture|fixture-secret/);
    return html;
  }

  const rateLimited = () => new Response(secret, { status: 429 });
  const firstUnavailable = await runCheck(rateLimited, "No confirmed failures. Some checks unavailable");
  assert.match(firstUnavailable.replace(/<[^>]+>/g, ""), /24h uptime n\/a/);
  await runCheck(() => runs(), "No CI runs on the default branch");
  await runCheck(() => runs(complete("success")), "Last confirmed passing");
  const preservedPass = await runCheck(rateLimited, "GitHub check unavailable · Rate limited");
  assert.match(preservedPass, /Last confirmed passing/);
  assert.match(preservedPass.replace(/<[^>]+>/g, ""), /24h uptime 100%/);
  const ignored = await runCheck(() => runs(complete("cancelled")), "All checks passing at last confirmation");
  assert.doesNotMatch(ignored, /GitHub check unavailable/);
  assert.match(ignored, /Last confirmed passing/);

  const down = await runCheck(() => runs(complete("failure")), "1 CI check failing");
  assert.match(down, /Fixture · ci \(CI\)/);
  assert.match(down.replace(/<[^>]+>/g, ""), /24h uptime 50%/);
  const preservedFailure = await runCheck(rateLimited, "GitHub check unavailable · Rate limited");
  assert.match(preservedFailure, /Last confirmed failing/);
  assert.match(preservedFailure, /1 CI check failing/);
  assert.doesNotMatch(preservedFailure, /service check failing|Last probe failed/);
  const recovered = await runCheck(() => runs(complete("success")), "Recovered");
  assert.match(recovered.replace(/<[^>]+>/g, ""), /24h uptime 66\.7%/);
  assert.doesNotMatch(recovered, /GitHub check unavailable/);
  await runCheck(() => runs(), "No CI runs on the default branch");

  using db = new Database(dbPath, { readonly: true });
  assert.deepEqual(db.query("SELECT ok FROM checks ORDER BY id").values().flat(),
    [null, null, 1, null, null, 0, null, 1, null]);
  assert.deepEqual(db.query("SELECT kind, error FROM events ORDER BY id").all(),
    [{ kind: "down", error: "CI check failed" }, { kind: "recovered", error: null }]);
} finally {
  await app?.stop();
  await fixture.stop(true);
  globalThis.fetch = nativeFetch;
  process.chdir(originalDirectory);
  await rm(directory, { recursive: true, force: true });
}

console.log("GitHub probe and core flow smoke checks passed.");
