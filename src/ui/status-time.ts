const relativeTime = new Intl.RelativeTimeFormat("en");

export function formatStatusAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds >= 86_400) return relativeTime.format(-Math.floor(seconds / 86_400), "day");
  if (seconds >= 3_600) return relativeTime.format(-Math.floor(seconds / 3_600), "hour");
  if (seconds >= 60) return relativeTime.format(-Math.floor(seconds / 60), "minute");
  if (seconds > 0) return relativeTime.format(-seconds, "second");
  return "just now";
}
