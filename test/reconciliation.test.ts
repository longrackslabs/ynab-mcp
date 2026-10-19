import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { YnabClient } from "../src/client.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { readReconciliationPlan, applyReconciliation } from "../src/reconciliation.js";
import { handleTool, enabledToolNames, type ToolContext } from "../src/tools.js";
import { parseToolsets } from "../src/toolsets.js";

function tx(id: string, amount: number, cleared = "cleared") {
  return {
    id,
    account_id: "a1",
    amount,
    cleared,
    approved: true,
    date: "2026-10-19",
    payee_id: "p1",
    category_id: "c1",
    memo: "Example",
    deleted: false,
    subtransactions: [],
  };
}
function setup(
  rows = [tx("old", 100000, "reconciled"), tx("t1", -10000), tx("pending", -5000, "uncleared")],
) {
  const writes: { id: string; body: Record<string, unknown> }[] = [];
  const paths: string[] = [];
  const accountOverride: Record<string, unknown> = {};
  const state = {
    rows,
    writes,
    paths,
    failId: "",
    timeoutAfterWrite: false,
    failVerification: false,
    changedApproval: false,
    dateUpdates: false,
    changeDuringRead: false,
    accountOverride,
  };
  let completedWrites = 0;
  const fn: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url),
      path = url.pathname;
    state.paths.push(req.method + " " + url.pathname + url.search);
    if (path.endsWith("/accounts/a1")) {
      const active = state.rows.filter((t) => !t.deleted);
      return new Response(
        JSON.stringify({
          data: {
            account: {
              id: "a1",
              name: "Example card",
              type: "creditCard",
              balance: active.reduce((s, t) => s + t.amount, 0),
              cleared_balance: active
                .filter((t) => t.cleared !== "uncleared")
                .reduce((s, t) => s + t.amount, 0),
              uncleared_balance: active
                .filter((t) => t.cleared === "uncleared")
                .reduce((s, t) => s + t.amount, 0),
              closed: false,
              deleted: false,
              last_reconciled_at:
                state.dateUpdates && completedWrites
                  ? "2026-10-19T12:00:00Z"
                  : "2026-10-01T12:00:00Z",
              ...state.accountOverride,
            },
          },
        }),
      );
    }
    if (path.endsWith("/accounts/a1/transactions")) {
      expect(url.searchParams.get("since_date")).toBe("1900-01-01");
      expect(url.searchParams.has("last_knowledge_of_server")).toBe(false);
      if (state.failVerification && completedWrites) throw new Error("verification unavailable");
      return new Response(JSON.stringify({ data: { transactions: state.rows } }));
    }
    const id = path.split("/").at(-1)!;
    const row = state.rows.find((t) => t.id === id);
    if (!row) throw new Error("Unexpected request " + path);
    if (req.method === "PUT") {
      const body = JSON.parse(await req.text()).transaction;
      state.writes.push({ id, body });
      if (id === state.failId) return new Response("synthetic failure", { status: 500 });
      Object.assign(row, body);
      completedWrites++;
      if (state.changedApproval) row.approved = false;
      if (state.timeoutAfterWrite) throw new Error("timeout after commit");
    } else if (state.changeDuringRead) row.memo = "Changed concurrently";
    return new Response(JSON.stringify({ data: { transaction: row } }));
  };
  const client = new YnabClient("synthetic", fn);
  const ctx: ToolContext = {
    client,
    enabledGroups: parseToolsets("all"),
    readOnly: false,
    defaultBudget: "b1",
    writePolicy: "clear-status",
    clearedWriteBudget: "b1",
    reconciliationWriteBudget: "b1",
  };
  return { state, client, ctx };
}
const input = { account_id: "a1", bank_balance_milliunits: 90000 };

describe("account transaction reconciliation", () => {
  it("previews without writes, using explicit full history and preserving pending entries", async () => {
    const { client, state } = setup();
    const plan = await readReconciliationPlan(client, "b1", input);
    expect(plan.preview.can_reconcile).toBe(true);
    expect(plan.preview.transactions.map((t) => t.id)).toEqual(["t1"]);
    expect(plan.preview.uncleared_count).toBe(1);
    expect(state.writes).toEqual([]);
  });
  it("reconciles only selected cleared entries and independently verifies the saved state", async () => {
    const { client, state } = setup();
    const plan = await readReconciliationPlan(client, "b1", input);
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.status).toBe("transactions_reconciled");
    expect(state.writes).toEqual([{ id: "t1", body: { cleared: "reconciled", approved: true } }]);
    expect(state.rows.find((t) => t.id === "pending")?.cleared).toBe("uncleared");
    expect(result).toMatchObject({
      verified_reconciled_ids: ["t1"],
      balances_unchanged: true,
      other_transactions_unchanged: true,
      account_reconciliation_date_changed: false,
    });
  });
  it("reports reconciliation-date changes only when the API actually returns them", async () => {
    const { client, state } = setup();
    state.dateUpdates = true;
    const plan = await readReconciliationPlan(client, "b1", input);
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.account_reconciliation_date_changed).toBe(true);
  });
  it("does not write if all posted entries are already reconciled", async () => {
    const { client, state } = setup();
    state.rows.find((t) => t.id === "t1")!.cleared = "reconciled";
    const plan = await readReconciliationPlan(client, "b1", input);
    expect(plan.preview.already_reconciled).toBe(true);
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.status).toBe("transactions_reconciled");
    expect(state.writes).toEqual([]);
  });
  it("blocks a mismatched bank balance even when pending transactions could explain it", async () => {
    const { client, state } = setup();
    const wrong = { ...input, bank_balance_milliunits: 85000 };
    const plan = await readReconciliationPlan(client, "b1", wrong);
    expect(plan.preview.can_reconcile).toBe(false);
    await expect(applyReconciliation(client, "b1", wrong, plan.preview.plan_id)).rejects.toThrow(
      /does not match/,
    );
    expect(state.writes).toEqual([]);
  });
  it("requires review of unapproved cleared entries", async () => {
    const { client, state } = setup();
    state.rows.find((t) => t.id === "t1")!.approved = false;
    const plan = await readReconciliationPlan(client, "b1", input);
    await expect(applyReconciliation(client, "b1", input, plan.preview.plan_id)).rejects.toThrow(
      /approve/,
    );
    expect(state.writes).toEqual([]);
  });
  it("invalidates a preview when an offsetting pair arrives, despite unchanged balances", async () => {
    const { client, state } = setup();
    const plan = await readReconciliationPlan(client, "b1", input);
    state.rows.push(tx("new1", 5000, "uncleared"), tx("new2", -5000, "uncleared"));
    await expect(applyReconciliation(client, "b1", input, plan.preview.plan_id)).rejects.toThrow(
      /stale/,
    );
    expect(state.writes).toEqual([]);
  });
  it("checks freshness again immediately before each write", async () => {
    const { client, state } = setup();
    const plan = await readReconciliationPlan(client, "b1", input);
    state.changeDuringRead = true;
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.status).toBe("incomplete");
    expect(state.writes).toEqual([]);
  });
  it("stops after a partial failure and reports which entries really saved", async () => {
    const { client, state } = setup([
      tx("old", 100000, "reconciled"),
      tx("t1", -5000),
      tx("t2", -5000),
      tx("pending", -5000, "uncleared"),
    ]);
    state.failId = "t2";
    const plan = await readReconciliationPlan(client, "b1", input);
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.status).toBe("incomplete");
    expect(result.verified_reconciled_ids).toEqual(["t1"]);
    expect(result.failed_or_uncertain_ids).toEqual(["t2"]);
    expect(state.writes.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("re-reads an ambiguous timeout without retrying a successful update", async () => {
    const { client, state } = setup();
    state.timeoutAfterWrite = true;
    const plan = await readReconciliationPlan(client, "b1", input);
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.status).toBe("incomplete");
    expect(result.verified_reconciled_ids).toEqual(["t1"]);
    expect(state.writes).toHaveLength(1);
  });
  it("reports failed verification without claiming success", async () => {
    const { client, state } = setup();
    state.failVerification = true;
    const plan = await readReconciliationPlan(client, "b1", input);
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.status).toBe("verification_failed");
    expect(result.completed_ids).toEqual(["t1"]);
  });
  it("catches unexpected approval side effects in the saved state", async () => {
    const { client, state } = setup();
    state.changedApproval = true;
    const plan = await readReconciliationPlan(client, "b1", input);
    const result = await applyReconciliation(client, "b1", input, plan.preview.plan_id);
    expect(result.status).toBe("incomplete");
    expect(result.verified_reconciled_ids).toEqual([]);
  });
  it.each(["duplicate", "cross-account", "status", "unsafe"])(
    "rejects malformed history: %s",
    async (problem) => {
      const { client, state } = setup();
      if (problem === "duplicate") state.rows.push({ ...state.rows[0]! });
      if (problem === "cross-account") state.rows[1]!.account_id = "other";
      if (problem === "status") state.rows[1]!.cleared = "invalid";
      if (problem === "unsafe") state.rows[1]!.amount = Number.MAX_SAFE_INTEGER + 1;
      await expect(readReconciliationPlan(client, "b1", input)).rejects.toThrow();
      expect(state.writes).toEqual([]);
    },
  );
  it.each([
    { balance: 1 },
    { cleared_balance: 1 },
    { uncleared_balance: 1 },
    { id: "other" },
    { deleted: true },
    { closed: true },
  ])("rejects inconsistent account snapshots: %j", async (override) => {
    const { client, state } = setup();
    state.accountOverride = override;
    await expect(readReconciliationPlan(client, "b1", input)).rejects.toThrow();
    expect(state.writes).toEqual([]);
  });
  it("requires a negative signed bank balance for credit-card debt", async () => {
    const { client } = setup([tx("t1", -90000), tx("pending", -5000, "uncleared")]);
    expect(
      (await readReconciliationPlan(client, "b1", { ...input, bank_balance_milliunits: -90000 }))
        .preview.can_reconcile,
    ).toBe(true);
    expect((await readReconciliationPlan(client, "b1", input)).preview.can_reconcile).toBe(false);
  });
  it("reports its operation cap before any update", async () => {
    const { client, state } = setup(Array.from({ length: 26 }, (_, i) => tx("t" + i, 0)));
    const zero = { ...input, bank_balance_milliunits: 0 };
    const plan = await readReconciliationPlan(client, "b1", zero);
    await expect(applyReconciliation(client, "b1", zero, plan.preview.plan_id)).rejects.toThrow(
      /25/,
    );
    expect(state.writes).toEqual([]);
  });
  it.each([
    { readOnly: true },
    { reconciliationWriteBudget: undefined },
    { writePolicy: undefined },
  ])("requires writable access and explicit opt-in: %j", async (policy) => {
    const { ctx, state } = setup();
    Object.assign(ctx, policy);
    expect(enabledToolNames(ctx).has("reconcile_account")).toBe(false);
    await expect(
      handleTool(ctx, "reconcile_account", { ...input, plan_id: "0".repeat(64) }),
    ).rejects.toThrow(/not enabled/);
    expect(state.paths).toEqual([]);
  });
  it("rejects extra arguments or another budget before reading account data", async () => {
    const { ctx, state } = setup();
    for (const args of [
      { ...input, plan_id: "0".repeat(64), approved: true },
      { ...input, plan_id: "0".repeat(64), budget_id: "other" },
    ])
      await expect(handleTool(ctx, "reconcile_account", args)).rejects.toThrow();
    expect(state.paths).toEqual([]);
  });
  it("advertises and executes the preview/apply sequence through MCP", async () => {
    const { ctx, state } = setup();
    const server = buildMcpServer(ctx),
      client = new Client({ name: "reconciliation-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const inventory = await client.listTools();
      expect(inventory.tools.some((t) => t.name === "reconcile_account")).toBe(true);
      const preview = await client.callTool({
        name: "preview_account_reconciliation",
        arguments: input,
      });
      const plan = JSON.parse(
        z.object({ content: z.array(z.object({ text: z.string() })) }).parse(preview).content[0]!
          .text,
      );
      expect(state.writes).toEqual([]);
      const result = await client.callTool({
        name: "reconcile_account",
        arguments: { ...input, plan_id: plan.plan_id },
      });
      expect(result.isError).not.toBe(true);
      expect(
        JSON.parse(
          z.object({ content: z.array(z.object({ text: z.string() })) }).parse(result).content[0]!
            .text,
        ).status,
      ).toBe("transactions_reconciled");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
