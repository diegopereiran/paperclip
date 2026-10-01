import { z } from "zod";
import { findUnsafeBindPath } from "../agent-process-bind-paths.js";

const bindPathSchema = z.string().superRefine((value, ctx) => {
  const reason = findUnsafeBindPath(value);
  if (reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: reason });
});

const networkAllowlistEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(/^[^\s*]+$/, "Use an exact hostname, hostname:port or origin URL");

const commandWrapperSchema = z
  .array(z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "must not contain NUL"))
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    const first = value[0];
    if (typeof first === "string" && !first.startsWith("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [0],
        message: "commandWrapper[0] must be an absolute path",
      });
    }
  });

export const agentProcessPolicySchema = z.object({
  mode: z.enum(["off", "enforce"]).optional(),
  filesystem: z.object({
    scope: z.literal("workspace").optional(),
    rw: z.array(bindPathSchema).max(256).optional(),
    ro: z.array(bindPathSchema).max(256).optional(),
    gitDir: z.enum(["auto", "off"]).optional(),
  }).strict().optional(),
  network: z.object({
    scope: z.enum(["shared", "deny", "allowlist"]).optional(),
    allowlist: z.array(networkAllowlistEntrySchema).max(256).optional(),
  }).strict().optional(),
  commandWrapper: commandWrapperSchema.optional(),
}).strict();

export type AgentProcessPolicyInput = z.infer<typeof agentProcessPolicySchema>;
