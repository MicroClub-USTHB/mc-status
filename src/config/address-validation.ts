import { isIP } from "node:net";

export function isValidHostname(value: string): boolean {
  const host = value.endsWith(".") ? value.slice(0, -1) : value;

  return (
    host.length > 0 &&
    host.length <= 253 &&
    !isIP(host) &&
    host
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
  );
}

export function isValidHttpUrl(value: string): boolean {
  return isValidWebUrl(value, false);
}

export function isValidHttpsUrl(value: string): boolean {
  return isValidWebUrl(value, true);
}

function isValidWebUrl(value: string, requireHttps: boolean): boolean {
  if (/\s/.test(value) || !/^https?:\/\//i.test(value)) return false;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");

    return (
      (requireHttps
        ? url.protocol === "https:"
        : ["http:", "https:"].includes(url.protocol)) &&
      !!host &&
      (!!isIP(host) || isValidHostname(host))
    );
  } catch {
    return false;
  }
}

export function isValidTcpAddress(value: string): boolean {
  return parseTcpAddress(value) !== null;
}

export function parseTcpAddress(value: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:\s/]+):(\d+)$/.exec(value);

  if (!match) return null;

  const addressHost = match[1]!;
  const bracketed = addressHost.startsWith("[");
  const host = bracketed ? addressHost.slice(1, -1) : addressHost;
  const port = Number(match[2]);

  const validHost = bracketed ? isIP(host) === 6 : isIP(host) === 4 || isValidHostname(host);
  if (!validHost || port < 1 || port > 65535) return null;
  return { host, port };
}

export function isValidGitHubRepository(value: string): boolean {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]+$/i.test(value) &&
    ![".", ".."].includes(value.split("/")[1]!)
  );
}
