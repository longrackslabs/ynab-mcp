import { describe, expect, it } from "vitest";

import { YnabClient } from "../src/client.js";
import { enabledToolNames, handleTool, TOOLS, type ToolContext } from "../src/tools.js";
import { parseToolsets } from "../src/toolsets.js";

function setup(
  txFields: Record<string, unknown> = {},
  categoryFields: Record<string, unknown> = {},
  ctxFields: Partial<ToolContext> = {},
) {
  const tx = {
    id: "t1",
    date: "2026-10-19",
    amount: -10000,
    account_id: "a1",
    category_id: null,
    cleared: "cleared",
    subtransactions: [],
    ...txFields,
  };
  const category = { id: "c1", name: "Example category", ...categoryFields };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.method === "GET" ? null : JSON.parse(await request.text());
    calls.push({ method: request.method, path, body });
    return new Response(
      JSON.stringify({
        data: path.includes("/categories/")
          ? { category }
          : { transaction: { ...tx, ...(body?.transaction ?? {}) } },
      }),
    );
  };
  const ctx: ToolContext = {
    client: new YnabClient("test", fn),
    enabledGroups: parseToolsets("all"),
    readOnly: false,
    defaultBudget: "last-used",
    writePolicy: "clear-status",
    clearedWriteBudget: "b1",
    categoryWriteBudget: "b1",
    ...ctxFields,
  };
  return { ctx, calls };
}
const args = { transaction_id: "t1", category_id: "c1", expected_category_id: null };

describe("restricted category writes", () => {
  it("exposes only cleared-status and category writes; all other writes stay blocked", async () => {
    const { ctx, calls } = setup();
    const enabled = enabledToolNames(ctx);
    expect(
      TOOLS.filter((t) => t.write && enabled.has(t.name))
        .map((t) => t.name)
        .sort(),
    ).toEqual(["set_transaction_category", "set_transaction_cleared"]);
    for (const t of TOOLS.filter(
      (t) => t.write && !["set_transaction_category", "set_transaction_cleared"].includes(t.name),
    )) {
      await expect(handleTool(ctx, t.name, {})).rejects.toThrow(/not enabled/);
    }
    expect(calls).toEqual([]);
  });
  it.each([{ readOnly: true }, { categoryWriteBudget: undefined }, { writePolicy: undefined }])(
    "requires explicit policy, budget opt-in, and a writable OAuth grant: %j",
    async (fields) => {
      const { ctx, calls } = setup({}, {}, fields);
      await expect(handleTool(ctx, "set_transaction_category", args)).rejects.toThrow(
        /not enabled/,
      );
      expect(calls).toEqual([]);
    },
  );
  it.each([
    "amount",
    "date",
    "payee_id",
    "payee_name",
    "account_id",
    "memo",
    "cleared",
    "approved",
    "subtransactions",
    "flag_color",
  ])("rejects extra field %s before API access", async (field) => {
    const { ctx, calls } = setup();
    await expect(
      handleTool(ctx, "set_transaction_category", { ...args, [field]: "forbidden" }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("rejects other budgets and missing expected category before API access", async () => {
    const { ctx, calls } = setup();
    await expect(
      handleTool(ctx, "set_transaction_category", { ...args, budget_id: "other" }),
    ).rejects.toThrow(/not enabled for this budget/);
    await expect(
      handleTool(ctx, "set_transaction_category", { transaction_id: "t1", category_id: "c1" }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it.each([
    { deleted: true },
    { id: "other" },
    { transfer_account_id: "a2" },
    { transfer_transaction_id: "other" },
    { subtransactions: [{ id: "s1", amount: -10000 }] },
    { category_id: "changed" },
  ])("refuses unsuitable or stale transactions: %j", async (fields) => {
    const { ctx, calls } = setup(fields);
    await expect(handleTool(ctx, "set_transaction_category", args)).rejects.toThrow();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it.each([
    { deleted: true },
    { hidden: true },
    { internal: true },
    { id: "other" },
    { category_group_name: "Internal Master Category" },
  ])("rejects unsuitable target categories: %j", async (fields) => {
    const { ctx, calls } = setup({}, fields);
    await expect(handleTool(ctx, "set_transaction_category", args)).rejects.toThrow(
      /active ordinary/,
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
  it("changes category while explicitly preserving approval and financial fields", async () => {
    const { ctx, calls } = setup();
    const out = JSON.parse(await handleTool(ctx, "set_transaction_category", args));
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT"]);
    expect(calls.every((c) => c.path.startsWith("/v1/budgets/b1/"))).toBe(true);
    expect(calls[2]?.body).toEqual({ transaction: { category_id: "c1", approved: false } });
    expect(out.category_id).toBe("c1");
    expect(out.amount).toBe(-10000);
    expect(out.cleared).toBe("cleared");
    expect(out.account_id).toBe("a1");
    expect(out.date).toBe("2026-10-19");
  });
  it.each([true, false])(
    "recategorizes reconciled entries without changing approval=%s or reconciliation",
    async (approved) => {
      const { ctx, calls } = setup({ cleared: "reconciled", approved, memo: "Preserve this" });
      const out = JSON.parse(await handleTool(ctx, "set_transaction_category", args));
      expect(calls[2]?.body).toEqual({ transaction: { category_id: "c1", approved } });
      expect(out.cleared).toBe("reconciled");
      expect(out.approved).toBe(approved);
      expect(out.amount).toBe(-10000);
      expect(out.memo).toBe("Preserve this");
    },
  );
  it("makes no write if category already matches", async () => {
    const { ctx, calls } = setup({ category_id: "c1" });
    await handleTool(ctx, "set_transaction_category", { ...args, expected_category_id: "c1" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
});
