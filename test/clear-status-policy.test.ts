import { describe, expect, it } from "vitest";

import { YnabClient } from "../src/client.js";
import { enabledToolNames, handleTool, TOOLS, type ToolContext } from "../src/tools.js";
import { parseToolsets } from "../src/toolsets.js";

function setup(status = "uncleared", readOnly = false) {
  const calls: { method: string; body: unknown }[] = [];
  const tx = { id: "t1", date: "2026-10-17", amount: -15990, account_id: "a1", cleared: status };
  const fn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? null : JSON.parse(await request.text());
    calls.push({ method: request.method, body });
    return new Response(
      JSON.stringify({ data: { transaction: { ...tx, ...(body?.transaction ?? {}) } } }),
    );
  };
  const ctx: ToolContext = {
    client: new YnabClient("test", fn),
    enabledGroups: parseToolsets("all"),
    readOnly,
    defaultBudget: "last-used",
    writePolicy: "clear-status",
    clearedWriteBudget: "b1",
  };
  return { ctx, calls };
}

describe("restricted cleared-status writes", () => {
  it("exposes exactly one write tool and keeps all other writes uncallable", async () => {
    const { ctx, calls } = setup();
    const enabled = enabledToolNames(ctx);
    expect(TOOLS.filter((t) => t.write && enabled.has(t.name)).map((t) => t.name)).toEqual([
      "set_transaction_cleared",
    ]);
    for (const tool of TOOLS.filter((t) => t.write && t.name !== "set_transaction_cleared")) {
      await expect(handleTool(ctx, tool.name, {})).rejects.toThrow(/not enabled/);
    }
    expect(calls).toEqual([]);
  });
  it("keeps read-only OAuth grants unable to use the new tool", async () => {
    const { ctx, calls } = setup("uncleared", true);
    await expect(
      handleTool(ctx, "set_transaction_cleared", { transaction_id: "t1", cleared: "cleared" }),
    ).rejects.toThrow(/not enabled/);
    expect(calls).toEqual([]);
  });
  it.each([
    "amount",
    "payee_name",
    "date",
    "category_id",
    "memo",
    "approved",
    "account_id",
    "subtransactions",
  ])("rejects the forbidden %s field before any API request", async (field) => {
    const { ctx, calls } = setup();
    await expect(
      handleTool(ctx, "set_transaction_cleared", {
        transaction_id: "t1",
        cleared: "cleared",
        [field]: "forbidden",
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("rejects setting reconciled or targeting a different budget", async () => {
    const { ctx, calls } = setup();
    await expect(
      handleTool(ctx, "set_transaction_cleared", { transaction_id: "t1", cleared: "reconciled" }),
    ).rejects.toThrow();
    await expect(
      handleTool(ctx, "set_transaction_cleared", {
        budget_id: "other",
        transaction_id: "t1",
        cleared: "cleared",
      }),
    ).rejects.toThrow(/not enabled for this budget/);
    expect(calls).toEqual([]);
  });
  it("refuses to alter a previously reconciled entry", async () => {
    const { ctx, calls } = setup("reconciled");
    await expect(
      handleTool(ctx, "set_transaction_cleared", { transaction_id: "t1", cleared: "uncleared" }),
    ).rejects.toThrow(/reconciled/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it.each(["cleared", "uncleared"])("sends only the %s status to the API", async (status) => {
    const { ctx, calls } = setup(status === "cleared" ? "uncleared" : "cleared");
    const result = JSON.parse(
      await handleTool(ctx, "set_transaction_cleared", { transaction_id: "t1", cleared: status }),
    );
    expect(calls).toEqual([
      { method: "GET", body: null },
      { method: "PUT", body: { transaction: { cleared: status } } },
    ]);
    expect(result.cleared).toBe(status);
    expect(result.amount).toBe(-15990);
  });
  it("does not write when status already matches", async () => {
    const { ctx, calls } = setup("cleared");
    await handleTool(ctx, "set_transaction_cleared", { transaction_id: "t1", cleared: "cleared" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
