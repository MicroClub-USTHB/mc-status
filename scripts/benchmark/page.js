import { check } from "k6";
import http from "k6/http";

const baseUrl = (__ENV.BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const profile = __ENV.PROFILE || "steady";

const scenarios = {
  // Start requests on a fixed schedule even when earlier requests are still running.
  steady: {
    executor: "constant-arrival-rate",
    rate: 5,
    timeUnit: "1s",
    duration: "2m",
    preAllocatedVUs: 20,
    gracefulStop: "15s",
  },
  // Start 20 clients together and have each request the page once.
  burst: {
    executor: "per-vu-iterations",
    vus: 20,
    iterations: 1,
    maxDuration: "15s",
  },
};

if (profile !== "steady" && profile !== "burst") {
  throw new Error("PROFILE must be steady or burst.");
}

export const options = {
  discardResponseBodies: true,
  scenarios: { [profile]: scenarios[profile] },
  summaryTrendStats: ["avg", "med", "p(95)", "max"],
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    http_reqs: [profile === "steady" ? "count==600" : "count==20"],
    ...(profile === "steady" ? { dropped_iterations: ["count==0"] } : {}),
  },
};

export default function () {
  const response = http.get(`${baseUrl}/`, { redirects: 0, timeout: "10s" });
  check(response, { "status page returns 200": (result) => result.status === 200 });
}
