import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("issue accepted-outcome columns", () => {
  it(
    "adds nullable timestamptz and text columns that read null on existing rows",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-accepted-outcome-migration-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => sql.end());

      const columns = await sql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'issues' AND column_name IN ('accepted_outcome_at', 'accepted_outcome_ref')
        ORDER BY column_name
      `;
      expect(columns.map((c) => ({ ...c }))).toEqual([
        { column_name: "accepted_outcome_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
        { column_name: "accepted_outcome_ref", data_type: "text", is_nullable: "YES", column_default: null },
      ]);

      const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('C', 'ACC') RETURNING id`;
      const [row] = await sql`INSERT INTO issues (company_id, title) VALUES (${company!.id}, 't') RETURNING accepted_outcome_at, accepted_outcome_ref`;
      expect(row).toEqual({ accepted_outcome_at: null, accepted_outcome_ref: null });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
