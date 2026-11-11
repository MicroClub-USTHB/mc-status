import statusCss from "../dist/status.css" with { type: "file" };
import statusClock from "../dist/status-clock.js" with { type: "file" };
import dmSans from "@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2" with { type: "file" };
import plusJakartaSans from "@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2" with { type: "file" };
import favicon from "./ui/favicon.png" with { type: "file" };
import { getActiveProjects, getConfigErrorMessage, loadTargetsConfig } from "./config";
import { getCheckSummary, getRecentOutages, openDatabase } from "./db";
import { startScheduler } from "./scheduler";
import { renderStatusPage } from "./ui/status-page";

export async function startServer(port = 3000) {
  let config;
  try {
    config = await loadTargetsConfig();
  } catch (error) {
    throw new Error(getConfigErrorMessage(error));
  }

  const projects = getActiveProjects(config);
  const activeChecks = new Map(projects.flatMap((project) =>
    project.checks.map((check) =>
      [check.checkId, { projectName: project.name, checkLabel: check.id, type: check.type }] as const,
    ),
  ));
  const activeCheckIds = [...activeChecks.keys()];
  const pageAssets = new Map([
    ["/assets/favicon.png", Bun.file(favicon, { type: "image/png" })],
    ["/assets/status.css", Bun.file(statusCss, { type: "text/css; charset=utf-8" })],
    ["/assets/status-clock.js", Bun.file(statusClock, { type: "text/javascript; charset=utf-8" })],
    ["/assets/dm-sans.woff2", Bun.file(dmSans, { type: "font/woff2" })],
    ["/assets/plus-jakarta-sans.woff2", Bun.file(plusJakartaSans, { type: "font/woff2" })],
  ]);

  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase();
  } catch {
    throw new Error("Could not open the SQLite database.");
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (request.method !== "GET") {
          return new Response("Not found", { status: 404 });
        }

        if (pathname === "/") {
          const now = Date.now();
          const statusProjects = projects.map(({ id, name, group, checks }) => ({
            id, name, group,
            checks: checks.map((check) => ({
              id: check.id,
              type: check.type,
              summary: getCheckSummary(db, check.checkId, now),
            })),
          }));
          const outages = getRecentOutages(db, activeCheckIds).flatMap((event) => {
            const label = activeChecks.get(event.checkId);
            return label ? [{ ...event, ...label }] : [];
          });

          return new Response(renderStatusPage(statusProjects, outages, now), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }

        if (pathname === "/healthz") {
          return new Response("ok", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }

        const asset = pageAssets.get(pathname);
        return asset ? new Response(asset) : new Response("Not found", { status: 404 });
      },
      error() {
        console.error("Could not serve the status request.");
        return new Response("Status temporarily unavailable", { status: 503 });
      },
    });
  } catch {
    db.close();
    throw new Error(`Could not start the status server on port ${port}.`);
  }

  let stopScheduler: ReturnType<typeof startScheduler>;
  try {
    stopScheduler = startScheduler(db, config);
  } catch {
    try {
      await server.stop(true);
    } finally {
      db.close();
    }
    throw new Error("Could not start the scheduler.");
  }
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    try {
      await stopScheduler();
      await server.stop();
    } finally {
      db.close();
    }
  })();

  return { port: server.port!, stop };
}

if (import.meta.main) {
  try {
    const { port, stop } = await startServer();
    console.log(`mc-status listening on port ${port}`);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not start mc-status.");
    process.exitCode = 1;
  }
}
