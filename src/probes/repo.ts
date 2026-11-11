import { z } from "zod";
import { isValidGitHubRepository } from "../config/address-validation";
import type { GitHubUnavailableReason } from "../db";
import type { ProbeOutcome } from "../state";

const repositorySchema = z.object({ default_branch: z.string().trim().min(1) });
const runsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.object({
    status: z.enum(["completed", "in_progress", "queued", "requested", "waiting", "pending"]),
    conclusion: z.string().trim().min(1).nullable(),
    created_at: z.iso.datetime({ offset: true }),
  })),
});
const apiErrorSchema = z.object({ message: z.string() });

async function readGitHubJson(url: URL, headers: Headers, signal: AbortSignal): Promise<
  { data: unknown } | { reason: GitHubUnavailableReason }
> {
  const response = await fetch(url, { headers, signal, redirect: "manual" });
  if (!response.ok) {
    const { status } = response;
    let reason: GitHubUnavailableReason = "http_error";
    if (status === 429 || (status === 403 && (
      response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
    ))) {
      reason = "rate_limit";
    } else if (status === 403) {
      const body = apiErrorSchema.safeParse(await response.json().catch(() => null));
      reason = body.success && /rate limit/i.test(body.data.message) ? "rate_limit" : "permission";
    } else if (status === 401 || status === 404) {
      reason = "permission";
    }
    void response.body?.cancel().catch(() => {});
    return { reason };
  }

  try {
    return { data: await response.json() };
  } catch (error) {
    if (error instanceof SyntaxError) return { reason: "invalid_response" };
    throw error;
  }
}

export async function probeRepo(
  repo: string,
  timeoutMs: number,
  stopSignal?: AbortSignal,
): Promise<{
  outcome: ProbeOutcome;
  latencyMs: number;
  githubUnavailableReason?: GitHubUnavailableReason;
}> {
  const startedAt = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = stopSignal ? AbortSignal.any([stopSignal, timeout]) : timeout;
  const latencyMs = () => Math.round(performance.now() - startedAt);
  const unavailable = (reason: GitHubUnavailableReason) => ({
    outcome: { type: "repo", kind: "unavailable", reason: "github_unavailable" } as const,
    latencyMs: latencyMs(),
    githubUnavailableReason: timeout.aborted ? "timeout" as const : reason,
  });

  if (!isValidGitHubRepository(repo)) return unavailable("invalid_response");

  try {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "User-Agent": "mc-status",
      "X-GitHub-Api-Version": "2026-03-10",
    });
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const repositoryUrl = new URL(`https://api.github.com/repos/${repo}`);
    const repositoryResponse = await readGitHubJson(repositoryUrl, headers, signal);
    if ("reason" in repositoryResponse) return unavailable(repositoryResponse.reason);
    const repository = repositorySchema.safeParse(repositoryResponse.data);
    if (!repository.success) return unavailable("invalid_response");

    const runsUrl = new URL(`${repositoryUrl.href}/actions/runs`);
    runsUrl.searchParams.set("branch", repository.data.default_branch);
    runsUrl.searchParams.set("per_page", "5");
    const runsResponse = await readGitHubJson(runsUrl, headers, signal);
    if ("reason" in runsResponse) return unavailable(runsResponse.reason);
    const runs = runsSchema.safeParse(runsResponse.data);
    if (!runs.success) return unavailable("invalid_response");

    const { total_count: count, workflow_runs: runsList } = runs.data;
    if (count < runsList.length || (count > 0 && runsList.length === 0)) {
      return unavailable("invalid_response");
    }
    if (count === 0) {
      return { outcome: { type: "repo", kind: "unavailable", reason: "no_ci" }, latencyMs: latencyMs() };
    }

    const latest = runsList.filter(({ status }) => status === "completed")
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (latest?.conclusion === null) return unavailable("invalid_response");

    let outcome: ProbeOutcome = { type: "repo", kind: "unavailable", reason: "ignored" };
    if (latest?.conclusion === "success") outcome = { type: "repo", kind: "success" };
    if (latest?.conclusion === "failure" || latest?.conclusion === "timed_out") {
      outcome = { type: "repo", kind: "failure", reason: "ci_failure" };
    }
    return { outcome, latencyMs: latencyMs() };
  } catch {
    return unavailable("network");
  }
}
