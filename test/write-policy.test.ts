import { describe, expect, it } from "vitest";

import { YnabClient } from "../src/client.js";
import { enabledToolNames, handleTool, TOOLS, type ToolContext } from "../src/tools.js";
import { parseReadOnly, parseToolsets } from "../src/toolsets.js";
import { parseWritePolicy } from "../src/write-policy.js";

const restricted = {
  YNAB_WRITE_POLICY: "clear-status",
  YNAB_CLEARED_WRITE_BUDGET: "example-budget",
};
function context(env: Record<string, string | undefined>) {
  const policy = parseWritePolicy(env);
  const calls: string[] = [];
  const client = new YnabClient("synthetic", async () => {
    calls.push("API");
    throw new Error("Unexpected API request");
  });
  const ctx: ToolContext = {
    client,
    enabledGroups: parseToolsets("all"),
    readOnly: parseReadOnly(env["YNAB_READ_ONLY"]),
    defaultBudget: "last-used",
    ...(policy.clearStatusOnly
      ? {
          writePolicy: "clear-status",
          clearedWriteBudget: policy.clearedWriteBudget,
          categoryWriteBudget: policy.categoryWriteBudget,
          categoryCreateBudget: policy.categoryCreateBudget,
          approvalWriteBudget: policy.approvalWriteBudget,
          reconciliationWriteBudget: policy.reconciliationWriteBudget,
        }
      : {}),
  };
  return { ctx, calls };
}
const restrictedNames = [
  "approve_transaction",
  "set_transaction_category",
  "set_transaction_cleared",
];
function writes(ctx: ToolContext) {
  const enabled = enabledToolNames(ctx);
  return TOOLS.filter((t) => t.write && enabled.has(t.name))
    .map((t) => t.name)
    .sort();
}

describe("optional restricted write policy", () => {
  it.each([{}, { YNAB_WRITE_POLICY: " " }])(
    "preserves every original upstream tool when no policy is selected: %j",
    (env) => {
      const { ctx } = context(env);
      expect(
        [...enabledToolNames(ctx)]
          .filter((name) => name !== "preview_account_reconciliation")
          .sort(),
      ).toEqual(
        TOOLS.filter(
          (t) =>
            ![...restrictedNames, "reconcile_account", "preview_account_reconciliation"].includes(
              t.name,
            ),
        )
          .map((t) => t.name)
          .sort(),
      );
      expect(writes(ctx)).toContain("update_transaction");
      expect(writes(ctx)).toContain("delete_transaction");
    },
  );
  it("enables only clearing until category or approval is explicitly opted in", () => {
    expect(writes(context(restricted).ctx)).toEqual(["set_transaction_cleared"]);
    expect(
      writes(context({ ...restricted, YNAB_CATEGORY_WRITE_BUDGET: "example-budget" }).ctx),
    ).toEqual(["set_transaction_category", "set_transaction_cleared"]);
    expect(
      writes(context({ ...restricted, YNAB_APPROVAL_WRITE_BUDGET: "example-budget" }).ctx),
    ).toEqual(["approve_transaction", "set_transaction_cleared"]);
  });
  it("requires a separate matching-budget reconciliation opt-in", () => {
    expect(
      writes(context({ ...restricted, YNAB_RECONCILIATION_WRITE_BUDGET: "example-budget" }).ctx),
    ).toEqual(["reconcile_account", "set_transaction_cleared"]);
    expect(
      writes(
        context({
          ...restricted,
          YNAB_RECONCILIATION_WRITE_BUDGET: "example-budget",
          YNAB_READ_ONLY: "true",
        }).ctx,
      ),
    ).toEqual([]);
    expect(() =>
      parseWritePolicy({ YNAB_RECONCILIATION_WRITE_BUDGET: "example-budget" }),
    ).toThrow();
    expect(() =>
      parseWritePolicy({ ...restricted, YNAB_RECONCILIATION_WRITE_BUDGET: "other" }),
    ).toThrow();
  });
  it("blocks general write calls before API access in restricted mode", async () => {
    const { ctx, calls } = context({
      ...restricted,
      YNAB_CATEGORY_WRITE_BUDGET: "example-budget",
      YNAB_APPROVAL_WRITE_BUDGET: "example-budget",
    });
    expect(writes(ctx)).toEqual(restrictedNames);
    for (const t of TOOLS.filter((t) => t.write && !restrictedNames.includes(t.name))) {
      await expect(handleTool(ctx, t.name, {})).rejects.toThrow(/not enabled/);
    }
    expect(calls).toEqual([]);
  });
  it.each([
    {},
    restricted,
    {
      ...restricted,
      YNAB_CATEGORY_WRITE_BUDGET: "example-budget",
      YNAB_APPROVAL_WRITE_BUDGET: "example-budget",
    },
  ])("read-only still overrides every write configuration: %j", (env) => {
    expect(writes(context({ ...env, YNAB_READ_ONLY: "true" }).ctx)).toEqual([]);
  });
  it.each([
    { YNAB_WRITE_POLICY: "typo" },
    { YNAB_WRITE_POLICY: "clear-status" },
    { YNAB_CLEARED_WRITE_BUDGET: "example-budget" },
    { YNAB_CATEGORY_WRITE_BUDGET: "example-budget" },
    { YNAB_APPROVAL_WRITE_BUDGET: "example-budget" },
    { ...restricted, YNAB_CATEGORY_WRITE_BUDGET: "other-budget" },
    { ...restricted, YNAB_APPROVAL_WRITE_BUDGET: "other-budget" },
  ])("rejects ambiguous or inconsistent policy settings: %j", (env) => {
    expect(() => parseWritePolicy(env)).toThrow();
  });
  it("trims configured values without treating an empty opt-in as enabled", () => {
    expect(
      parseWritePolicy({
        YNAB_WRITE_POLICY: " clear-status ",
        YNAB_CLEARED_WRITE_BUDGET: " example-budget ",
        YNAB_APPROVAL_WRITE_BUDGET: " ",
      }),
    ).toEqual({
      clearStatusOnly: true,
      clearedWriteBudget: "example-budget",
      categoryWriteBudget: undefined,
      categoryCreateBudget: undefined,
      approvalWriteBudget: undefined,
      reconciliationWriteBudget: undefined,
    });
  });
});
