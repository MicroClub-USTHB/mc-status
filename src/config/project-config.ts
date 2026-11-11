import { ConfigError } from "./config-errors";
import type {
  CheckConfig,
  TargetsConfig,
  ValidatedTargetsInput,
  ProjectConfig,
} from "./config-schema";

export function createProjectId(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeTargetsConfig(
  input: ValidatedTargetsInput,
): TargetsConfig {
  const seenProjectNames = new Set<string>();
  const seenProjectIds = new Set<string>();

  const projects = input.projects.map(
    (project, projectIndex): ProjectConfig => {
      const projectId = createProjectId(project.name);

      // Different display names can produce the same slug; reject rather than share history.
      if (
        !projectId ||
        seenProjectNames.has(project.name) ||
        seenProjectIds.has(projectId)
      ) {
        throw new ConfigError(
          `Invalid targets.yaml: projects.${projectIndex}.name must produce a nonempty, unique project ID and have a unique name`,
        );
      }

      seenProjectNames.add(project.name);
      seenProjectIds.add(projectId);

      const seenCheckIds = new Set<string>();

      const checks = project.checks.map((check, checkIndex): CheckConfig => {
        if (seenCheckIds.has(check.id)) {
          throw new ConfigError(
            `Invalid targets.yaml: projects.${projectIndex}.checks.${checkIndex}.id must be unique within its project`,
          );
        }

        seenCheckIds.add(check.id);

        return {
          ...check,
          checkId: `${projectId}/${check.id}`,
          enabled: (check.type === "repo" ? check.repo : check.url) !== "",
        };
      });

      return { ...project, id: projectId, checks };
    },
  );

  return { ...input, projects };
}

export function getActiveProjects(config: TargetsConfig): ProjectConfig[] {
  // Keep disabled entries in the original config for later startup logging.
  return config.projects
    .map((project) => ({
      ...project,
      checks: project.checks.filter((check) => check.enabled),
    }))
    .filter((project) => project.checks.length > 0);
}
