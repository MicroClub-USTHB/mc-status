// Bun's file loader returns the asset path. TypeScript 7.0 does not infer it.
declare module "*/dist/status.css" {
  const path: string;
  export default path;
}

declare module "*/dist/status-clock.js" {
  const path: string;
  export default path;
}

declare module "*.woff2" {
  const path: string;
  export default path;
}

declare module "*/favicon.png" {
  const path: string;
  export default path;
}
