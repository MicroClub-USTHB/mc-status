import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import {
  getActiveProjects,
  checkTypeSchema,
  ConfigError,
  parseTargetsYaml,
  projectGroupSchema,
} from "../src/config";

const fixture = (checks: unknown[], name = "Test service") => ({
  interval: 60,
  timeout: 10,
  projects: [{ name, group: "Core", checks }],
});
const parse = (value: unknown) => parseTargetsYaml(stringify(value));
const rejects = (value: unknown) =>
  assert.throws(() => parse(value), ConfigError);

for (const group of projectGroupSchema.options) {
  const config = parse({
    ...fixture([]),
    projects: [{ ...fixture([]).projects[0], group }],
  });
  assert.equal(config.projects[0]!.group, group);
}
for (const group of ["Services", "core", "", " Core ", "Other", 1]) {
  rejects({
    ...fixture([]),
    projects: [{ ...fixture([]).projects[0], group }],
  });
}
assert.deepEqual(checkTypeSchema.options, [
  "http",
  "tcp",
  "dns",
  "tls",
  "repo",
]);
for (const type of ["HTTP", " http ", "", "invalid"]) {
  rejects(fixture([{ id: "check", type }]));
}

const disabled = parse(
  fixture([
    { id: "missing", type: "http" },
    { id: "empty", type: "tcp", url: "" },
    { id: "spaces", type: "dns", url: "   " },
    { id: "certificate", type: "tls" },
    { id: "ci", type: "repo", repo: " " },
  ]),
);
assert.equal(disabled.projects[0]!.checks.length, 5);
assert.deepEqual(getActiveProjects(disabled), []);
const mixed = parse(
  fixture([
    { id: "web", type: "http", url: "https://example.test/" },
    { id: "other-web", type: "http", url: " http://localhost:8080/ " },
    { id: "socket", type: "tcp", url: "[::1]:1234" },
    { id: "dns", type: "dns", url: "example.test" },
    { id: "certificate", type: "tls", url: "https://example.test:8443/" },
    { id: "ci", type: "repo", repo: "example/project" },
    { id: "disabled", type: "dns", url: "" },
  ]),
);
assert.equal(getActiveProjects(mixed)[0]!.checks.length, 6);
assert.equal(mixed.projects[0]!.checks[0]!.checkId, "test-service/web");
assert.equal(mixed.projects[0]!.checks[1]!.type, "http");
assert.equal(
  parse(fixture([], "Changed name")).projects[0]!.id,
  "changed-name",
);
for (const [type, field, value] of [
  ["http", "url", "file:///secret"],
  ["http", "url", "not-a-url"],
  ["tcp", "url", "localhost"],
  ["tcp", "url", "localhost:0"],
  ["tcp", "url", "localhost:65536"],
  ["tcp", "url", "[localhost]:443"],
  ["tcp", "url", "[127.0.0.1]:443"],
  ["tcp", "url", "::1:443"],
  ["tcp", "url", "http://localhost:443"],
  ["dns", "url", "https://example.test"],
  ["dns", "url", "127.0.0.1"],
  ["tls", "url", "http://example.test"],
  ["repo", "repo", "https://github.com/example/project"],
  ["repo", "repo", "example/.."],
])
  rejects(fixture([{ id: "check", type, [field!]: value }]));
rejects(fixture([{ id: "Bad_ID", type: "http" }]));
rejects(
  fixture([
    { id: "web", type: "http" },
    { id: "web", type: "dns" },
  ]),
);
rejects(fixture([{ id: "check", type: "invalid" }]));
rejects(fixture([{ id: "check", type: "http", repo: "example/project" }]));
rejects(fixture([], "!!!"));
rejects({ ...fixture([]), projects: [{ name: "x", checks: [] }] });
for (const names of [
  ["Same", "Same"],
  ["Test service", "test-service"],
]) {
  rejects({
    ...fixture([]),
    projects: names.map((name) => ({ name, group: "Core", checks: [] })),
  });
}
for (const value of [0, -1, "60", 2_147_484]) {
  rejects({ ...fixture([]), interval: value });
  rejects({ ...fixture([]), timeout: value });
}
for (const notify_user of [
  "<@123456789012345678>",
  123456789012345678,
  "abc",
]) {
  const value = fixture([]);
  rejects({
    ...value,
    projects: value.projects.map((p) => ({ ...p, notify_user })),
  });
}
parse({
  ...fixture([]),
  projects: [{ ...fixture([]).projects[0], notify_user: "123456789012345678" }],
});
assert.throws(() => parseTargetsYaml("projects: [secret"), ConfigError);
assert.throws(
  () => parseTargetsYaml("interval: 60\ninterval: 30\nprojects: []"),
  ConfigError,
);

// CLI smoke checks use temporary working directories, never edit real targets.
const directory = await mkdtemp(join(tmpdir(), "mc-status-config-"));
const validate = resolve("src/validate.ts");
const server = resolve("src/server.ts");
let requests = 0;
const receiver = Bun.serve({
  port: 0,
  fetch() {
    requests++;
    return new Response("ok");
  },
});
const run = async (entry: string) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DISCORD_WEBHOOK_URL: `${receiver.url}secret-webhook`,
    },
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const code = await child.exited;
    return { code, output: (await output).join("\n") };
  } finally {
    clearTimeout(timer);
  }
};
try {
  const committed = parseTargetsYaml(await Bun.file("targets.yaml").text());
  assert.equal(committed.projects.length, 15);
  assert.equal(
    committed.projects.reduce((n, p) => n + p.checks.length, 0),
    31,
  );
  assert.equal(getActiveProjects(committed).length, 0);
  assert.equal((await run(validate)).code, 1); // missing file
  await writeFile(
    join(directory, "targets.yaml"),
    stringify(
      fixture([{ id: "web", type: "http", url: receiver.url.toString() }]),
    ),
  );
  const valid = await run(validate);
  assert.equal(valid.code, 0);
  assert.match(valid.output, /1 active projects, 1 active checks/);
  assert.equal(
    requests,
    0,
    "Validation must not probe targets or send notifications",
  );
  const secret = "PRIVATE_SECRET_VALUE";
  for (const source of [
    stringify(fixture([{ id: "web", type: "http", url: `bad://${secret}` }])),
    `projects: [${secret}`,
    stringify({ ...fixture([]), [secret]: "hidden" }),
  ]) {
    await writeFile(join(directory, "targets.yaml"), source);
    const invalid = await run(validate);
    assert.equal(invalid.code, 1);
    assert.ok(!invalid.output.includes(secret));
    assert.match(invalid.output, /Invalid targets.yaml/);
  }
  const startup = await run(server);
  assert.equal(startup.code, 1);
  assert.ok(!startup.output.includes("listening"));
  assert.ok(!startup.output.includes(secret));
  assert.equal(requests, 0);
} finally {
  await receiver.stop(true);
  await rm(directory, { recursive: true, force: true });
}
console.log("Config smoke checks passed");
