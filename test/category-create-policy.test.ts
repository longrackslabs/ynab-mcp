import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { YnabClient } from "../src/client.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { enabledToolNames, handleTool, type ToolContext } from "../src/tools.js";
import { parseToolsets } from "../src/toolsets.js";
import { parseWritePolicy } from "../src/write-policy.js";

const config = {
  YNAB_WRITE_POLICY: "clear-status",
  YNAB_CLEARED_WRITE_BUDGET: "b1",
  YNAB_CATEGORY_CREATE_BUDGET: "b1",
};
const args = { name: "Example", category_group_id: "g1" };
function setup(
  groupFields: Record<string, unknown> = {},
  overrides: Partial<ToolContext> = {},
  resultFields: Record<string, unknown> = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fn: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const body = req.method === "GET" ? null : JSON.parse(await req.text());
    calls.push({ method: req.method, path: new URL(req.url).pathname, body });
    return new Response(
      JSON.stringify({
        data:
          req.method === "GET"
            ? {
                category_groups: [
                  {
                    id: "g1",
                    name: "Example group",
                    internal: false,
                    categories: [],
                    ...groupFields,
                  },
                ],
              }
            : { category: { id: "c1", name: args.name, category_group_id: "g1", ...resultFields } },
      }),
    );
  };
  const ctx: ToolContext = {
    client: new YnabClient("synthetic", fn),
    enabledGroups: parseToolsets("all"),
    readOnly: false,
    defaultBudget: "other",
    writePolicy: "clear-status",
    clearedWriteBudget: "b1",
    categoryCreateBudget: "b1",
    ...overrides,
  };
  return { ctx, calls };
}
describe("selective category creation", () => {
  it.each([false, true])(
    "enforces permission and strict arguments through MCP, readOnly=%s",
    async (readOnly) => {
      const { ctx, calls } = setup({}, { readOnly });
      const server = buildMcpServer(ctx);
      const client = new Client({ name: "creation-test", version: "1.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(st);
        await client.connect(ct);
        expect((await client.listTools()).tools.some((t) => t.name === "create_category")).toBe(
          !readOnly,
        );
        const rejected = await client.callTool({
          name: "create_category",
          arguments: { ...args, goal_target: 1000 },
        });
        expect(rejected.isError).toBe(true);
        expect(calls).toHaveLength(0);
        const result = await client.callTool({ name: "create_category", arguments: args });
        expect(Boolean(result.isError)).toBe(readOnly);
        expect(calls).toHaveLength(readOnly ? 0 : 2);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  it("creates only name and group in the configured budget", async () => {
    const { ctx, calls } = setup();
    const result = JSON.parse(await handleTool(ctx, "create_category", args));
    expect(result.id).toBe("c1");
    expect(calls).toEqual([
      { method: "GET", path: "/v1/budgets/b1/categories", body: null },
      { method: "POST", path: "/v1/budgets/b1/categories", body: { category: args } },
    ]);
    for (const name of [
      "update_category",
      "create_category_group",
      "update_category_group",
      "update_category_budget",
      "delete_transaction",
    ])
      expect(enabledToolNames(ctx).has(name)).toBe(false);
  });
  it.each([
    { categoryCreateBudget: undefined },
    { readOnly: true },
    { enabledGroups: parseToolsets("accounts") },
  ])("blocks discovery and dispatch without permission %j", async (overrides) => {
    const { ctx, calls } = setup({}, overrides);
    expect(enabledToolNames(ctx).has("create_category")).toBe(false);
    await expect(handleTool(ctx, "create_category", args)).rejects.toThrow(/not enabled/);
    expect(calls).toEqual([]);
  });
  it.each([
    { goal_target: 1000 },
    { note: "extra" },
    { hidden: true },
    { name: " " },
    { budget_id: "other" },
  ])("rejects forbidden arguments before API access %j", async (extra) => {
    const { ctx, calls } = setup();
    await expect(handleTool(ctx, "create_category", { ...args, ...extra })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it.each([
    { hidden: true },
    { deleted: true },
    { internal: true },
    { internal: undefined },
    { id: "other" },
    { categories: [{ id: "existing", name: " EXAMPLE " }] },
  ])("refuses invalid groups and duplicate names without writing %j", async (group) => {
    const { ctx, calls } = setup(group);
    await expect(handleTool(ctx, "create_category", args)).rejects.toThrow();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it("reports an unexpected creation response without retrying", async () => {
    const { ctx, calls } = setup({}, {}, { category_group_id: "wrong" });
    await expect(handleTool(ctx, "create_category", args)).rejects.toThrow(/Re-read/);
    expect(calls).toHaveLength(2);
  });
  it("requires its own matching budget opt-in", () => {
    expect(parseWritePolicy(config).categoryCreateBudget).toBe("b1");
    expect(() => parseWritePolicy({ YNAB_CATEGORY_CREATE_BUDGET: "b1" })).toThrow();
    expect(() => parseWritePolicy({ ...config, YNAB_CATEGORY_CREATE_BUDGET: "other" })).toThrow();
  });
});
