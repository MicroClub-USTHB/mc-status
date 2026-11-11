/// <reference lib="dom" />

import { formatStatusAge } from "./status-time";

const timestamps = Array.from(document.querySelectorAll<HTMLTimeElement>("time[data-age-ms]"), (element) => ({
  element,
  ageMs: Number(element.dataset.ageMs),
}));

if (timestamps.length > 0) {
  // Advance the server-rendered ages without relying on the browser's wall clock.
  const startedAt = performance.now();
  const update = () => {
    const elapsedMs = performance.now() - startedAt;
    for (const { element, ageMs } of timestamps) {
      const label = formatStatusAge(ageMs + elapsedMs);
      if (element.textContent !== label) element.textContent = label;
    }
  };

  setInterval(update, 1_000);
  document.addEventListener("visibilitychange", update);
}
