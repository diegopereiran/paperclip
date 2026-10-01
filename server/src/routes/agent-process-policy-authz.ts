import type { Request } from "express";
import { agentProcessPolicyWidening } from "@paperclipai/adapter-utils/agent-process-policy";
import {
  assertAgentProcessPolicyValid,
  readRuntimeConfigProcessPolicy,
} from "../services/agent-process-policy-guard.js";
import { assertInstanceAdmin } from "./authz.js";

/**
 * Gate a write of an agent's process policy. The policy must be valid, and a
 * change that loosens confinement compared with `previous` needs an instance
 * admin. Narrowing is free for anyone allowed to edit the agent.
 */
export function assertAgentProcessPolicyWriteAllowed(req: Request, next: unknown, previous?: unknown): void {
  const nextPolicy = assertAgentProcessPolicyValid(next);
  const previousPolicy = previous === undefined || previous === null ? undefined : previous;
  if (agentProcessPolicyWidening(previousPolicy as never, nextPolicy).length > 0) assertInstanceAdmin(req);
}

export function assertRuntimeConfigProcessPolicyWriteAllowed(
  req: Request,
  nextRuntimeConfig: unknown,
  previousRuntimeConfig?: unknown,
): void {
  assertAgentProcessPolicyWriteAllowed(
    req,
    readRuntimeConfigProcessPolicy(nextRuntimeConfig),
    readRuntimeConfigProcessPolicy(previousRuntimeConfig),
  );
}
