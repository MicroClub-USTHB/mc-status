import {
  getActiveProjects,
  getConfigErrorMessage,
  loadTargetsConfig,
} from "./config";

try {
  const config = await loadTargetsConfig();
  const active = getActiveProjects(config);
  const checks = active.reduce(
    (count, project) => count + project.checks.length,
    0,
  );

  console.log(
    `targets.yaml valid: ${active.length} active projects, ${checks} active checks`,
  );
} catch (error) {
  console.error(getConfigErrorMessage(error));
  process.exitCode = 1;
}
