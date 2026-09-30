import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A viewer lands on the dashboard, so it stays readable, but the monthly
// spend and budget figures are cost data and must not reach a viewer.

const companyId = "11111111-1111-4111-8111-111111111111";

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

vi.mock("../services/recovery-observability.js", () => ({
  DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT: 10,
  MAX_WINDOW_WEEKS: 52,
  recoveryObservabilityService: () => ({ report: vi.fn() }),
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
  const [{ errorHandler }, { dashboardRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/dashboard.js"),
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", dashboardRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("dashboard route viewer read lockdown", () => {
  beforeEach(() => {
    mockDashboardService.summary.mockReset();
    mockDashboardService.summary.mockResolvedValue({
      companyId,
      tasks: { open: 3 },
      costs: { monthSpendCents: 12345, monthBudgetCents: 50000, monthUtilizationPercent: 24.69 },
    });
  });

  it("returns the dashboard to a viewer without cost figures", async () => {
    const app = await createApp(actorWithRole("viewer"));
    const res = await request(app).get(`/api/companies/${companyId}/dashboard`);

    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual({ open: 3 });
    expect(res.body.costs).toBeNull();
  });

  it("keeps cost figures for an operator", async () => {
    const app = await createApp(actorWithRole("operator"));
    const res = await request(app).get(`/api/companies/${companyId}/dashboard`);

    expect(res.status).toBe(200);
    expect(res.body.costs.monthSpendCents).toBe(12345);
  });
});
