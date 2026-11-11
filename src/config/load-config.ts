import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { ConfigError, createConfigValidationError } from "./config-errors";
import { normalizeTargetsConfig } from "./project-config";
import { targetsConfigSchema, type TargetsConfig } from "./config-schema";

export function parseTargetsYaml(source: string): TargetsConfig {
  let input: unknown;

  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      stringKeys: true,
    });

    if (document.errors.length || document.warnings.length) throw new Error();

    input = document.toJS({ maxAliasCount: 100 });
  } catch {
    // Parser messages may contain source values or secrets.
    throw new ConfigError(
      "Invalid targets.yaml: malformed YAML or unsupported YAML tags",
    );
  }

  const result = targetsConfigSchema.safeParse(input);

  if (!result.success) throw createConfigValidationError(result.error.issues);

  return normalizeTargetsConfig(result.data);
}

export async function loadTargetsConfig(): Promise<TargetsConfig> {
  let source: string;

  try {
    source = await readFile("targets.yaml", "utf8");
  } catch {
    throw new ConfigError(
      "Cannot read targets.yaml from the working directory",
    );
  }

  return parseTargetsYaml(source);
}
