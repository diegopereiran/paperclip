import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { findSessionFingerprintAgentConfigRevision } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("findSessionFingerprintAgentConfigRevision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("session-fingerprint-revision-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Session fingerprint revisions",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "codex_local", status: "idle" });
    return { companyId, agentId };
  }

  async function addRevision(companyId: string, agentId: string, changedKeys: string[], minute: number) {
    const id = randomUUID();
    await db.insert(agentConfigRevisions).values({
      id,
      companyId,
      agentId,
      changedKeys,
      beforeConfig: {},
      afterConfig: {},
      createdAt: new Date(Date.UTC(2026, 5, 1, 0, minute)),
    });
    return id;
  }

  it("finds the latest qualifying revision behind more than 50 content-hashed edits", async () => {
    const { companyId, agentId } = await seedAgent();
    const named = await addRevision(companyId, agentId, ["name"], 0);
    for (let i = 1; i <= 51; i += 1) {
      await addRevision(companyId, agentId, i % 2 ? ["runtimeConfig"] : ["adapterConfig", "runtimeConfig"], i);
    }
    const found = await findSessionFingerprintAgentConfigRevision(db, companyId, agentId);
    expect(found?.id).toBe(named);
  });

  it("returns null when only content-hashed revisions exist and treats empty changedKeys as qualifying", async () => {
    const { companyId, agentId } = await seedAgent();
    await addRevision(companyId, agentId, ["runtimeConfig"], 1);
    expect(await findSessionFingerprintAgentConfigRevision(db, companyId, agentId)).toBeNull();
    const empty = await addRevision(companyId, agentId, [], 2);
    await addRevision(companyId, agentId, ["adapterConfig"], 3);
    expect((await findSessionFingerprintAgentConfigRevision(db, companyId, agentId))?.id).toBe(empty);
  });
});
