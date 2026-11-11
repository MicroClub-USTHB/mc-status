import { z } from "zod";
import {
  isValidHostname,
  isValidGitHubRepository,
  isValidTcpAddress,
  isValidHttpUrl,
  isValidHttpsUrl,
} from "./address-validation";

export const projectGroupSchema = z.enum(["Core", "Infra", "Repos"]);

export type ProjectGroup = z.infer<typeof projectGroupSchema>;

export const checkTypeSchema = z.enum(["http", "tcp", "dns", "tls", "repo"]);

export type CheckType = z.infer<typeof checkTypeSchema>;

// Blank or omitted addresses disable a check; validate only filled addresses.
const createOptionalAddressSchema = (
  isValidAddress: (value: string) => boolean,
  message: string,
) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => value ?? "")
    .refine((value) => value === "" || isValidAddress(value), { message });

const checkIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase hyphenated check ID");

// The type selects both the allowed address field and its validation rules.
const checkSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: checkIdSchema,
    type: checkTypeSchema.extract(["http"]),
    url: createOptionalAddressSchema(
      isValidHttpUrl,
      "Expected an HTTP or HTTPS address",
    ),
  }),
  z.strictObject({
    id: checkIdSchema,
    type: checkTypeSchema.extract(["tcp"]),
    url: createOptionalAddressSchema(
      isValidTcpAddress,
      "Expected host:port or [IPv6]:port",
    ),
  }),
  z.strictObject({
    id: checkIdSchema,
    type: checkTypeSchema.extract(["dns"]),
    url: createOptionalAddressSchema(
      isValidHostname,
      "Expected a plain DNS hostname",
    ),
  }),
  z.strictObject({
    id: checkIdSchema,
    type: checkTypeSchema.extract(["tls"]),
    url: createOptionalAddressSchema(
      isValidHttpsUrl,
      "Expected an HTTPS address",
    ),
  }),
  z.strictObject({
    id: checkIdSchema,
    type: checkTypeSchema.extract(["repo"]),
    repo: createOptionalAddressSchema(
      isValidGitHubRepository,
      "Expected a GitHub owner/name",
    ),
  }),
]);

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Use a nonempty single-line display name",
  );

// Milliseconds must fit the timers used by the probes and scheduler.
const durationSecondsSchema = z.number().positive().max(2_147_483.647);

export const targetsConfigSchema = z.strictObject({
  interval: durationSecondsSchema,
  timeout: durationSecondsSchema,
  projects: z.array(
    z.strictObject({
      name: displayNameSchema,
      group: projectGroupSchema,
      notify_user: z
        .string()
        .trim()
        .regex(
          /^(?:[1-9][0-9]{16,19})?$/,
          "Expected a quoted Discord user ID or empty string",
        )
        .optional(),
      checks: z.array(checkSchema),
    }),
  ),
});

export type ValidatedTargetsInput = z.infer<typeof targetsConfigSchema>;

type CheckInput = z.infer<typeof checkSchema>;

// Runtime configuration adds identities and enabled flags after schema validation.
export type CheckConfig = CheckInput & { checkId: string; enabled: boolean };

export type ProjectConfig = Omit<
  ValidatedTargetsInput["projects"][number],
  "checks"
> & {
  id: string;
  checks: CheckConfig[];
};

export type TargetsConfig = {
  interval: number;
  timeout: number;
  projects: ProjectConfig[];
};
