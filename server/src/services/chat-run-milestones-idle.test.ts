import { createDb } from "@paperclipai/db";
import { getTableName, type Table } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { enqueueChatRunMilestones } from "./chat-run-publications.js";

// Records the name of the table every select starts from, then runs the real query.
// Names, not table objects: a failure message that prints a drizzle table never finishes.
function recordingDb(db: ReturnType<typeof createDb>) {
  const tables: string[] = [];
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "select") {
        return (...args: unknown[]) => {
          const builder = (target.select as (...a: unknown[]) => { from: (...a: unknown[]) => unknown })(...args);
          const from = builder.from.bind(builder);
          builder.from = (table: unknown, ...rest: unknown[]) => {
            tables.push(getTableName(table as Table));
            return from(table, ...rest);
          };
          return builder;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped, tables };
}

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Chat run milestone database unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("enqueueChatRunMilestones without open chat conversations", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-chat-milestones-idle-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("returns 0 without scanning heartbeat runs", async () => {
    const recorded = recordingDb(db);
    expect(await enqueueChatRunMilestones(recorded.db)).toBe(0);
    expect(recorded.tables).toContain("chat_conversations");
    expect(recorded.tables).not.toContain("heartbeat_runs");
  });
});
