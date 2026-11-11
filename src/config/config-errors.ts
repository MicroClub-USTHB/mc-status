import type { z } from "zod";

export class ConfigError extends Error {}

export function createConfigValidationError(issues: z.ZodIssue[]): ConfigError {
  // Report known field locations without echoing arbitrary YAML keys or values.
  const fields = new Set([
    "interval",
    "timeout",
    "projects",
    "name",
    "group",
    "notify_user",
    "checks",
    "id",
    "type",
    "url",
    "repo",
  ]);

  const messages = issues.map((issue) => {
    const path =
      issue.path
        .filter((part) => typeof part === "number" || fields.has(String(part)))
        .join(".") || "config";

    let message = "Invalid or missing value (check fields and value types)";

    if (issue.code === "custom" || issue.code === "invalid_format") {
      message = issue.message;
    } else if (issue.path.at(-1) === "group") {
      message = "Expected Core, Infra, or Repos";
    } else if (issue.path.at(-1) === "type") {
      message = "Expected http, tcp, dns, tls, or repo";
    }

    return `${path}: ${message}`;
  });

  return new ConfigError(`Invalid targets.yaml:\n${messages.join("\n")}`);
}

export function getConfigErrorMessage(error: unknown): string {
  return error instanceof ConfigError
    ? error.message
    : "Could not validate targets.yaml";
}
