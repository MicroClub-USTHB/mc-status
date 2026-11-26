import statusCss from "../../dist/status.css" with { type: "file" };
import statusClock from "../../dist/status-clock.js" with { type: "file" };
import dmSans from "@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2" with { type: "file" };
import bricolageGrotesque from "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2" with { type: "file" };
import favicon from "./favicon.png" with { type: "file" };
import ogImage from "./og-image.png" with { type: "file" };

export const pageAssets = new Map([
  ["/assets/favicon.png", Bun.file(favicon, { type: "image/png" })],
  ["/assets/og-image.png", Bun.file(ogImage, { type: "image/png" })],
  ["/assets/status.css", Bun.file(statusCss, { type: "text/css; charset=utf-8" })],
  ["/assets/status-clock.js", Bun.file(statusClock, { type: "text/javascript; charset=utf-8" })],
  ["/assets/dm-sans.woff2", Bun.file(dmSans, { type: "font/woff2" })],
  ["/assets/bricolage-grotesque.woff2", Bun.file(bricolageGrotesque, { type: "font/woff2" })],
]);
