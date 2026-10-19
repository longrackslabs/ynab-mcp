import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { YnabClient } from "../src/client.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { enabledToolNames, handleTool, TOOLS, type ToolContext } from "../src/tools.js";
import { parseToolsets } from "../src/toolsets.js";

function setup(fields: Record<string, unknown> = {}, policy: Partial<ToolContext> = {}) {
  const tx = {
    id: "t1",
    account_id: "a1",
    date: "2026-10-19",
    amount: -10000,
    payee_id: "p1",
    category_id: "c1",
    approved: false,
    cleared: "cleared",
    memo: "Example",
    subtransactions: [],
    ...fields,
  };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fn: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const body = req.method === "GET" ? null : JSON.parse(await req.text());
    calls.push({ method: req.method, path: new URL(req.url).pathname, body });
    return new Response(
      JSON.stringify({ data: { transaction: { ...tx, ...(body?.transaction ?? {}) } } }),
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
    approvalWriteBudget: "b1",
    ...policy,
  };
  return { ctx, calls, tx };
}
const args = { transaction_id: "t1", expected_category_id: "c1" };

describe("restricted transaction approval", () => {
  it.each([false, true])(
    "enforces approval policy through the MCP protocol, readOnly=%s",
    async (readOnly) => {
      const { ctx, calls } = setup({}, { readOnly });
      const server = buildMcpServer(ctx);
      const client = new Client({ name: "approval-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const inventory = await client.listTools();
        expect(inventory.tools.some((t) => t.name === "approve_transaction")).toBe(!readOnly);
        const result = await client.callTool({ name: "approve_transaction", arguments: args });
        expect(Boolean(result.isError)).toBe(readOnly);
        if (readOnly) expect(calls).toEqual([]);
        else {
          expect(calls[1]?.body).toEqual({ transaction: { approved: true } });
          const forbidden = await client.callTool({
            name: "approve_transaction",
            arguments: { ...args, approved: false },
          });
          expect(forbidden.isError).toBe(true);
          expect(calls).toHaveLength(2);
        }
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  it("exposes only the three restricted writes and blocks every general write", async () => {
    const { ctx, calls } = setup();
    const enabled = enabledToolNames(ctx);
    const allowed = ["approve_transaction", "set_transaction_category", "set_transaction_cleared"];
    expect(
      TOOLS.filter((t) => t.write && enabled.has(t.name))
        .map((t) => t.name)
        .sort(),
    ).toEqual(allowed);
    for (const t of TOOLS.filter((t) => t.write && !allowed.includes(t.name))) {
      await expect(handleTool(ctx, t.name, {})).rejects.toThrow(/not enabled/);
    }
    expect(calls).toEqual([]);
  });
  it.each([
    { readOnly: true },
    { approvalWriteBudget: undefined },
    { writePolicy: undefined },
    { enabledGroups: parseToolsets("accounts") },
  ])("requires explicit opt-in and writable access: %j", async (policy) => {
    const { ctx, calls } = setup({}, policy);
    await expect(handleTool(ctx, "approve_transaction", args)).rejects.toThrow(/not enabled/);
    expect(calls).toEqual([]);
  });
  it.each([
    "amount",
    "date",
    "payee_id",
    "payee_name",
    "category_id",
    "account_id",
    "memo",
    "cleared",
    "approved",
    "subtransactions",
    "flag_color",
    "import_id",
  ])("rejects field %s before any API access", async (field) => {
    const { ctx, calls } = setup();
    await expect(
      handleTool(ctx, "approve_transaction", {
        ...args,
        [field]: field === "approved" ? false : "forbidden",
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("rejects a different budget, missing review category and path injection before API access", async () => {
    const { ctx, calls } = setup();
    for (const input of [
      { ...args, budget_id: "other" },
      { transaction_id: "t1" },
      { ...args, transaction_id: "../t1" },
    ]) {
      await expect(handleTool(ctx, "approve_transaction", input)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
  it.each([
    { deleted: true },
    { cleared: "reconciled" },
    { id: "other" },
    { transfer_account_id: "a2" },
    { transfer_transaction_id: "t2" },
    { subtransactions: [{ id: "s1", amount: -10000 }] },
    { category_id: "changed" },
  ])("blocks unsuitable or changed entries: %j", async (fields) => {
    const { ctx, calls } = setup(fields);
    await expect(handleTool(ctx, "approve_transaction", args)).rejects.toThrow();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it.each(["cleared", "uncleared"])(
    "accepts a %s transaction without changing its clearing state",
    async (cleared) => {
      const { ctx, calls, tx } = setup({ cleared });
      const out = JSON.parse(await handleTool(ctx, "approve_transaction", args));
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
      expect(calls.every((c) => c.path === "/v1/budgets/b1/transactions/t1")).toBe(true);
      expect(calls[1]?.body).toEqual({ transaction: { approved: true } });
      expect(out.approved).toBe(true);
      for (const field of [
        "id",
        "account_id",
        "date",
        "amount",
        "payee_id",
        "category_id",
        "cleared",
        "memo",
      ] as const)
        expect(out[field]).toBe(tx[field]);
    },
  );
  it("allows a reviewed null category without recategorizing", async () => {
    const { ctx } = setup({ category_id: null });
    const out = JSON.parse(
      await handleTool(ctx, "approve_transaction", { ...args, expected_category_id: null }),
    );
    expect(out.approved).toBe(true);
    expect(out.category_id).toBe(null);
  });
  it("does not write again when already accepted", async () => {
    const { ctx, calls } = setup({ approved: true });
    const out = JSON.parse(await handleTool(ctx, "approve_transaction", args));
    expect(out.approved).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
