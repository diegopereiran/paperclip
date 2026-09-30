import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A viewer follows issue work but must not read company spend. The decision
// engine is mocked to allow everything, so a 403 can only come from the
// viewer check.

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";

const mockCostService = vi.hoisted(() => ({
  summary: vi.fn(),
  issueTreeSummary: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  budgetService: () => mockBudgetService,
  costService: () => mockCostService,
  financeService: () => ({}),
  companyService: () => mockCompanyService,
  agentService: () => ({}),
  issueService: () => mockIssueService,
  heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn() }),
  accessService: () => mockAccessService,
  logActivity: vi.fn(),
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: mockFetchAllQuotaWindows,
}));

function actorWithRole(membershipRole: string) {
  return {
    type: "board",
    userId: `${membershipRole}-user`,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole }],
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { costRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/costs.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("cost routes viewer read lockdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_test", explanation: "test" });
    mockCostService.summary.mockResolvedValue({ spendCents: 0 });
    mockCostService.issueTreeSummary.mockResolvedValue({ spendCents: 0 });
    mockBudgetService.overview.mockResolvedValue({});
    mockCompanyService.getById.mockResolvedValue({ id: companyId });
    mockFetchAllQuotaWindows.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      projectId: null,
      parentId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      status: "todo",
    });
  });

  it.each([
    [`/api/companies/${companyId}/costs/summary`, () => mockCostService.summary],
    [`/api/companies/${companyId}/budgets/overview`, () => mockBudgetService.overview],
    [`/api/issues/${issueId}/cost-summary`, () => mockCostService.issueTreeSummary],
    [`/api/companies/${companyId}/costs/quota-windows`, () => mockFetchAllQuotaWindows],
  ])("denies a viewer GET %s", async (path, readFn) => {
    const app = await createApp(actorWithRole("viewer"));
    const res = await request(app).get(path);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Viewer access does not include costs");
    expect(readFn()).not.toHaveBeenCalled();
  });

  it("still lets an operator read the cost summary", async () => {
    const app = await createApp(actorWithRole("operator"));
    const res = await request(app).get(`/api/companies/${companyId}/costs/summary`);

    expect(res.status).toBe(200);
    expect(mockCostService.summary).toHaveBeenCalled();
  });
});
