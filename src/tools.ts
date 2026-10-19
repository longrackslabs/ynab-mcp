// ============================================================================
// Tool catalog + dispatch.
//
// `TOOLS` is the pure data array of MCP tool definitions (tagged with `group`
// and `write` for toolset gating). `handleTool` parses args, calls the
// injected `YnabClient`, and folds in pure logic (dedupe, summary). It returns
// a string; the server bootstrap wraps errors. No env / no process access here
// so the whole layer is unit-testable with a fake-fetch client.
// ============================================================================

import { z } from "zod";

import type { YnabClient } from "./client.js";
import type { DupTxn } from "./duplicates.js";
import type { SummaryTxn } from "./summary.js";
import type { ToolGroup } from "./toolsets.js";
import type { SaveScheduledTxnFields } from "./transactions.js";

import { findDuplicateTransactions } from "./duplicates.js";
import {
  formatAccount,
  formatCategory,
  formatCategoryGroup,
  formatMonth,
  formatMoneyMovement,
  formatMoneyMovementGroup,
  formatPayee,
  formatPayeeLocation,
  formatScheduledTransaction,
  formatTransaction,
} from "./format.js";
import { readReconciliationPlan, applyReconciliation } from "./reconciliation.js";
import { summarizeSpending } from "./summary.js";
import { isToolEnabled } from "./toolsets.js";

export interface ToolContext {
  client: YnabClient;
  enabledGroups: Set<ToolGroup>;
  readOnly: boolean;
  defaultBudget: string;
  writePolicy?: "clear-status";
  clearedWriteBudget?: string;
  categoryWriteBudget?: string;
  approvalWriteBudget?: string;
  reconciliationWriteBudget?: string;
}

// The YNAB API operation(s) a tool actually calls, for the generated reference's
// backlinks (site/scripts/generate-reference.ts, docs site "Reference" section).
// `opAnchor` is the https://api.ynab.com/v1 interactive-docs deep link
// (`#/<Tag>/<operationId>`), verified against the live spec at
// https://api.ynab.com/papi/open_api_spec.yaml. That spec's current top-level
// resource tag is "Plans" (YNAB renamed Budget→Plan API-side); this server and its
// docs keep calling it a Budget (CONTEXT.md), and the client still calls the
// `/budgets/...` path form, which the API still serves as a working alias.
export interface Endpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  opAnchor: string;
}

export interface ToolDef {
  name: string;
  group: ToolGroup;
  write: boolean;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  endpoints: Endpoint[];
}

const YNAB_API_DOCS = "https://api.ynab.com/v1";

function ep(method: Endpoint["method"], path: string, tag: string, operationId: string): Endpoint {
  return { method, path, opAnchor: `${YNAB_API_DOCS}#/${tag}/${operationId}` };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const BudgetArg = z.object({ budget_id: z.string().optional() }).passthrough();
const BudgetDeltaArg = BudgetArg.extend({ last_knowledge_of_server: z.number().optional() });
const ListBudgetsInput = z.object({ include_accounts: z.boolean().optional() }).passthrough();
const AccountRef = BudgetArg.extend({ account_id: z.string() });
const CategoryRef = BudgetArg.extend({ category_id: z.string() });
const TransactionRef = BudgetArg.extend({ transaction_id: z.string() });
const MonthRef = BudgetArg.extend({ month: z.string().default("current") });
const PayeeRef = BudgetArg.extend({ payee_id: z.string() });

const AccountReconciliationInput = z
  .object({
    budget_id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    account_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    bank_balance_milliunits: z.number().int().safe(),
  })
  .strict();
const ApplyAccountReconciliationInput = AccountReconciliationInput.extend({
  plan_id: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const ApproveTransactionInput = z
  .object({
    budget_id: z.string().optional(),
    transaction_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    expected_category_id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .nullable(),
  })
  .strict();

const SetTransactionCategoryInput = z
  .object({
    budget_id: z.string().optional(),
    transaction_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    category_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    expected_category_id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .nullable(),
  })
  .strict();

const flagColor = z.enum(["red", "orange", "yellow", "green", "blue", "purple"]);
const cleared = z.enum(["cleared", "uncleared", "reconciled"]);
const SetTransactionClearedInput = z
  .object({
    budget_id: z.string().optional(),
    transaction_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    cleared: z.enum(["cleared", "uncleared"]),
  })
  .strict();

const ListTransactionsInput = BudgetArg.extend({
  account_id: z.string().optional(),
  since_date: z.string().optional(),
  until_date: z.string().optional(),
  type: z.enum(["uncategorized", "unapproved"]).optional(),
  last_knowledge_of_server: z.number().optional(),
  max_results: z.number().default(50),
});

const UpdateCategoryBudgetInput = BudgetArg.extend({
  month: z.string().default("current"),
  category_id: z.string(),
  budgeted: z.number(),
});

const SaveTxnShape = {
  payee_id: z.string().optional(),
  payee_name: z.string().optional(),
  category_id: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  cleared: cleared.optional(),
  approved: z.boolean().optional(),
  flag_color: flagColor.nullable().optional(),
};

const SubtransactionInput = z.object({
  amount: z.number(),
  payee_id: z.string().optional(),
  payee_name: z.string().optional(),
  category_id: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
});

const CreateTransactionInput = BudgetArg.extend({
  account_id: z.string(),
  date: z.string(),
  amount: z.number(),
  import_id: z.string().optional(),
  subtransactions: z.array(SubtransactionInput).optional(),
  ...SaveTxnShape,
}).superRefine((val, ctx) => {
  // A split's legs must sum to the parent amount, or YNAB rejects it.
  if (val.subtransactions && val.subtransactions.length > 0) {
    const sum = val.subtransactions.reduce((acc, s) => acc + s.amount, 0);
    if (sum !== val.amount) {
      ctx.addIssue({
        code: "custom",
        message: `Split legs sum to ${sum} but the transaction amount is ${val.amount} — they must match (milliunits).`,
      });
    }
  }
});

const UpdateTransactionInput = TransactionRef.extend({
  date: z.string().optional(),
  amount: z.number().optional(),
  ...SaveTxnShape,
});

const BulkUpdateInput = BudgetArg.extend({
  updates: z
    .array(
      z.object({
        id: z.string(),
        category_id: z.string().nullable().optional(),
        approved: z.boolean().optional(),
        memo: z.string().nullable().optional(),
        cleared: cleared.optional(),
        flag_color: flagColor.nullable().optional(),
      }),
    )
    .min(1),
});

const CreateAccountInput = BudgetArg.extend({
  name: z.string(),
  type: z.enum(["checking", "savings", "cash", "creditCard", "otherAsset", "otherLiability"]),
  balance: z.number().default(0),
});

const FindDuplicatesInput = BudgetArg.extend({
  account_id: z.string().optional(),
  since_date: z.string().optional(),
});

const SpendingSummaryInput = BudgetArg.extend({
  group_by: z.enum(["category", "payee"]).default("category"),
  account_id: z.string().optional(),
  since_date: z.string().optional(),
  until_date: z.string().optional(),
});

const PayeeTxnsInput = PayeeRef.extend({
  since_date: z.string().optional(),
  until_date: z.string().optional(),
  type: z.enum(["uncategorized", "unapproved"]).optional(),
  last_knowledge_of_server: z.number().optional(),
});
const CategoryTxnsInput = CategoryRef.extend({
  since_date: z.string().optional(),
  until_date: z.string().optional(),
  type: z.enum(["uncategorized", "unapproved"]).optional(),
  last_knowledge_of_server: z.number().optional(),
});

const UpdatePayeeInput = PayeeRef.extend({ name: z.string() });
const CreatePayeeInput = BudgetArg.extend({ name: z.string() });
const PayeeLocationRef = BudgetArg.extend({ payee_location_id: z.string() });
const MonthCategoryRef = MonthRef.extend({ category_id: z.string() });
const MonthTxnsInput = MonthRef.extend({
  since_date: z.string().optional(),
  until_date: z.string().optional(),
  type: z.enum(["uncategorized", "unapproved"]).optional(),
  last_knowledge_of_server: z.number().optional(),
});

const BulkCreateItem = z.object({
  account_id: z.string(),
  date: z.string(),
  amount: z.number(),
  import_id: z.string().optional(),
  subtransactions: z.array(SubtransactionInput).optional(),
  ...SaveTxnShape,
});
const BulkCreateInput = BudgetArg.extend({ transactions: z.array(BulkCreateItem).min(1) });

const CreateCategoryInput = BudgetArg.extend({
  name: z.string(),
  category_group_id: z.string(),
  goal_target: z.number().nullable().optional(),
  goal_target_date: z.string().nullable().optional(),
  goal_needs_whole_amount: z.boolean().nullable().optional(),
});
const UpdateCategoryInput = CategoryRef.extend({
  name: z.string().optional(),
  note: z.string().nullable().optional(),
  category_group_id: z.string().optional(),
  goal_target: z.number().nullable().optional(),
  goal_target_date: z.string().nullable().optional(),
  goal_needs_whole_amount: z.boolean().nullable().optional(),
});
const CreateCategoryGroupInput = BudgetArg.extend({ name: z.string() });
const UpdateCategoryGroupInput = BudgetArg.extend({
  category_group_id: z.string(),
  name: z.string(),
});

const frequency = z.enum([
  "never",
  "daily",
  "weekly",
  "everyOtherWeek",
  "twiceAMonth",
  "every4Weeks",
  "monthly",
  "everyOtherMonth",
  "every3Months",
  "every4Months",
  "twiceAYear",
  "yearly",
  "everyOtherYear",
]);

const ScheduledTxnRef = BudgetArg.extend({ scheduled_transaction_id: z.string() });

const ScheduledOptionalShape = {
  payee_id: z.string().optional(),
  payee_name: z.string().optional(),
  category_id: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  flag_color: flagColor.nullable().optional(),
};

const CreateScheduledTxnInput = BudgetArg.extend({
  account_id: z.string(),
  date: z.string(),
  amount: z.number(),
  frequency,
  ...ScheduledOptionalShape,
});

const UpdateScheduledTxnInput = ScheduledTxnRef.extend({
  date: z.string().optional(),
  amount: z.number().optional(),
  frequency: frequency.optional(),
  ...ScheduledOptionalShape,
});

const MoneyMovementMonthInput = MonthRef;

// ---------------------------------------------------------------------------
// Tool definitions (JSON schemas for the wire)
// ---------------------------------------------------------------------------

const budgetIdProp = {
  budget_id: {
    type: "string",
    description: 'Budget id or alias ("last-used", "default"). Defaults to YNAB_BUDGET_ID.',
  },
} as const;

const txnFieldProps = {
  payee_id: { type: "string" },
  payee_name: { type: "string" },
  category_id: { type: "string", description: "null clears the category (uncategorize)." },
  memo: { type: "string" },
  cleared: { type: "string", enum: ["cleared", "uncleared", "reconciled"] },
  approved: { type: "boolean" },
  flag_color: { type: "string", enum: ["red", "orange", "yellow", "green", "blue", "purple"] },
} as const;

const subtransactionProps = {
  amount: {
    type: "number",
    description: "Milliunits; same sign as the parent (legs sum to amount).",
  },
  category_id: { type: "string" },
  payee_id: { type: "string" },
  payee_name: { type: "string" },
  memo: { type: "string" },
} as const;

export const TOOLS: ToolDef[] = [
  {
    name: "set_transaction_cleared",
    group: "transactions",
    write: true,
    description:
      "Set only the cleared or uncleared status of an existing transaction in the approved budget. Cannot change reconciled transactions, amounts, dates, categories, payees, or delete anything.",
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "getTransactionById",
      ),
      ep(
        "PUT",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "updateTransaction",
      ),
    ],
    inputSchema: {
      type: "object",
      properties: {
        budget_id: { type: "string" },
        transaction_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        cleared: { type: "string", enum: ["cleared", "uncleared"] },
      },
      required: ["transaction_id", "cleared"],
      additionalProperties: false,
    },
  },
  {
    name: "set_transaction_category",
    group: "transactions",
    write: true,
    description:
      "Set only the category of an existing ordinary transaction in the approved budget. Requires the expected current category (null for uncategorized). Rejects transfers, splits, deleted or reconciled entries, and inactive/internal categories. Cannot change amounts, dates, payees, cleared status, or delete anything.",
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "getTransactionById",
      ),
      ep("GET", "/budgets/{budget_id}/categories/{category_id}", "Categories", "getCategoryById"),
      ep(
        "PUT",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "updateTransaction",
      ),
    ],
    inputSchema: {
      type: "object",
      properties: {
        budget_id: { type: "string" },
        transaction_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        category_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        expected_category_id: {
          type: ["string", "null"],
          pattern: "^[a-zA-Z0-9_-]+$",
          description:
            "Current category id from a fresh read; null for an uncategorized transaction.",
        },
      },
      required: ["transaction_id", "category_id", "expected_category_id"],
      additionalProperties: false,
    },
  },
  {
    name: "approve_transaction",
    group: "transactions",
    write: true,
    description:
      "Accept an existing ordinary transaction by setting only approved to true in the approved budget. Requires the reviewed current category (null if uncategorized). Cannot unapprove, clear, recategorize, change financial fields, or delete. Rejects deleted/reconciled entries, transfers, and splits.",
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "getTransactionById",
      ),
      ep(
        "PUT",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "updateTransaction",
      ),
    ],
    inputSchema: {
      type: "object",
      properties: {
        budget_id: { type: "string" },
        transaction_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        expected_category_id: {
          type: ["string", "null"],
          pattern: "^[a-zA-Z0-9_-]+$",
          description:
            "Current category id from review; null for uncategorized. Stops if the category changed.",
        },
      },
      required: ["transaction_id", "expected_category_id"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_account_reconciliation",
    group: "transactions",
    write: false,
    description:
      "Read-only account reconciliation preview. Requires the signed bank posted balance in integer milliunits (card debt negative). Reads full history, validates totals, lists cleared entries to mark reconciled, and reports blockers. Does not verify bank posting or change data.",
    endpoints: [
      ep("GET", "/budgets/{budget_id}/accounts/{account_id}", "Accounts", "getAccountById"),
      ep(
        "GET",
        "/budgets/{budget_id}/accounts/{account_id}/transactions",
        "Transactions",
        "getTransactionsByAccount",
      ),
    ],
    inputSchema: {
      type: "object",
      properties: {
        budget_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        account_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        bank_balance_milliunits: {
          type: "integer",
          description:
            "Signed posted bank balance in milliunits; 1000 is one unit. Credit-card debt must be negative. Exclude pending activity.",
        },
      },
      required: ["account_id", "bank_balance_milliunits"],
      additionalProperties: false,
    },
  },
  {
    name: "reconcile_account",
    group: "transactions",
    write: true,
    description:
      "Apply an explicitly approved account reconciliation preview using its plan_id. Only already-cleared, approved transactions become reconciled; uncleared entries are never cleared. Requires a matching bank balance, unchanged preview, and an opted-in budget. Maximum 25 entries. Reports partial failures and independently verifies results. The API has no account-level reconciliation endpoint; account reconciliation-date behavior is reported separately.",
    endpoints: [
      ep("GET", "/budgets/{budget_id}/accounts/{account_id}", "Accounts", "getAccountById"),
      ep(
        "GET",
        "/budgets/{budget_id}/accounts/{account_id}/transactions",
        "Transactions",
        "getTransactionsByAccount",
      ),
      ep(
        "GET",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "getTransactionById",
      ),
      ep(
        "PUT",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "updateTransaction",
      ),
    ],
    inputSchema: {
      type: "object",
      properties: {
        budget_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        account_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
        bank_balance_milliunits: {
          type: "integer",
          description: "Same signed posted bank balance in milliunits as the approved preview.",
        },
        plan_id: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "plan_id from the reviewed read-only preview.",
        },
      },
      required: ["account_id", "bank_balance_milliunits", "plan_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_budgets",
    group: "budgets",
    write: false,
    endpoints: [ep("GET", "/budgets", "Plans", "getPlans")],
    description: "List all budgets on the account (id, name, currency, date range).",
    inputSchema: {
      type: "object",
      properties: {
        include_accounts: {
          type: "boolean",
          description: "Include account summaries in each budget.",
        },
      },
    },
  },
  {
    name: "get_budget",
    group: "budgets",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}", "Plans", "getPlanById")],
    description: "Get one full budget export, optionally as a delta from server knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        last_knowledge_of_server: { type: "number" },
      },
    },
  },
  {
    name: "budget_settings",
    group: "budgets",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/settings", "Plans", "getPlanSettingsById")],
    description: "Currency and date-format settings for a budget.",
    inputSchema: { type: "object", properties: { ...budgetIdProp } },
  },
  {
    name: "list_accounts",
    group: "accounts",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/accounts", "Accounts", "getAccounts")],
    description: "List accounts in a budget with balances (milliunits + units).",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, last_knowledge_of_server: { type: "number" } },
    },
  },
  {
    name: "get_account",
    group: "accounts",
    write: false,
    endpoints: [
      ep("GET", "/budgets/{budget_id}/accounts/{account_id}", "Accounts", "getAccountById"),
    ],
    description: "Get one account by id.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, account_id: { type: "string" } },
      required: ["account_id"],
    },
  },
  {
    name: "create_account",
    group: "accounts",
    write: true,
    endpoints: [ep("POST", "/budgets/{budget_id}/accounts", "Accounts", "createAccount")],
    description:
      "Create a MANUAL account (name, type, starting balance in milliunits). The API cannot link a bank for direct import — that is YNAB app-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["checking", "savings", "cash", "creditCard", "otherAsset", "otherLiability"],
        },
        balance: { type: "number", description: "Starting balance in milliunits.", default: 0 },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "list_categories",
    group: "categories",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/categories", "Categories", "getCategories")],
    description: "List category groups and their categories (budgeted, activity, balance).",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, last_knowledge_of_server: { type: "number" } },
    },
  },
  {
    name: "get_category",
    group: "categories",
    write: false,
    endpoints: [
      ep("GET", "/budgets/{budget_id}/categories/{category_id}", "Categories", "getCategoryById"),
    ],
    description: "Get one category by id (current month figures).",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, category_id: { type: "string" } },
      required: ["category_id"],
    },
  },
  {
    name: "update_category_budget",
    group: "categories",
    write: true,
    endpoints: [
      ep(
        "PATCH",
        "/budgets/{budget_id}/months/{month}/categories/{category_id}",
        "Categories",
        "updateMonthCategory",
      ),
    ],
    description: "Set the budgeted amount (milliunits) for a category in a given month.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        month: { type: "string", description: '"YYYY-MM-01" or "current".', default: "current" },
        category_id: { type: "string" },
        budgeted: { type: "number", description: "Budgeted amount in milliunits (1000 = 1 unit)." },
      },
      required: ["category_id", "budgeted"],
    },
  },
  {
    name: "list_transactions",
    group: "transactions",
    write: false,
    endpoints: [
      ep("GET", "/budgets/{budget_id}/transactions", "Transactions", "getTransactions"),
      ep(
        "GET",
        "/budgets/{budget_id}/accounts/{account_id}/transactions",
        "Transactions",
        "getTransactionsByAccount",
      ),
    ],
    description:
      "List transactions. Optionally scope to an account, a since_date, or a type filter (uncategorized/unapproved).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        account_id: { type: "string" },
        since_date: { type: "string" },
        until_date: { type: "string" },
        type: { type: "string", enum: ["uncategorized", "unapproved"] },
        last_knowledge_of_server: { type: "number" },
        max_results: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "get_transaction",
    group: "transactions",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "getTransactionById",
      ),
    ],
    description: "Get one transaction by id.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, transaction_id: { type: "string" } },
      required: ["transaction_id"],
    },
  },
  {
    name: "create_transaction",
    group: "transactions",
    write: true,
    endpoints: [
      ep("POST", "/budgets/{budget_id}/transactions", "Transactions", "createTransaction"),
    ],
    description:
      "Create a transaction. amount is milliunits (negative = outflow). For a SPLIT across categories (e.g. a mixed Walmart/Target/Amazon receipt), set category_id to null and pass subtransactions whose amounts sum to amount; optionally set import_id so it matches the later bank-imported transaction. YNAB supports splits only on create — the leg breakdown of an existing split cannot be edited via the API.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        account_id: { type: "string" },
        date: { type: "string", description: "ISO date, e.g. 2026-06-08." },
        amount: { type: "number", description: "Milliunits; negative outflow, positive inflow." },
        import_id: {
          type: "string",
          description: "Optional dedupe/match key so a later bank import reconciles to this txn.",
        },
        subtransactions: {
          type: "array",
          description:
            "Split legs. Set the parent category_id to null; leg amounts must sum to amount.",
          items: { type: "object", properties: subtransactionProps, required: ["amount"] },
        },
        ...txnFieldProps,
      },
      required: ["account_id", "date", "amount"],
    },
  },
  {
    name: "update_transaction",
    group: "transactions",
    write: true,
    endpoints: [
      ep(
        "PUT",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "updateTransaction",
      ),
    ],
    description: "Update fields on an existing transaction (only provided fields change).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        transaction_id: { type: "string" },
        date: { type: "string" },
        amount: { type: "number", description: "Milliunits." },
        ...txnFieldProps,
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "bulk_update_transactions",
    group: "transactions",
    write: true,
    endpoints: [
      ep("PATCH", "/budgets/{budget_id}/transactions", "Transactions", "updateTransactions"),
    ],
    description:
      "Update many transactions in ONE call (the efficient way to categorize and/or approve a batch). Each update needs an id.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        updates: {
          type: "array",
          description: "Per-transaction updates; each item needs `id` plus the fields to change.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, ...txnFieldProps },
            required: ["id"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "delete_transaction",
    group: "transactions",
    write: true,
    endpoints: [
      ep(
        "DELETE",
        "/budgets/{budget_id}/transactions/{transaction_id}",
        "Transactions",
        "deleteTransaction",
      ),
    ],
    description: "Delete a transaction by id (use after confirming a duplicate).",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, transaction_id: { type: "string" } },
      required: ["transaction_id"],
    },
  },
  {
    name: "find_duplicate_transactions",
    group: "transactions",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/transactions", "Transactions", "getTransactions")],
    description:
      "Find candidate duplicate transactions (same account + amount + date). Returns clusters for review — does NOT delete. Pair with delete_transaction.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        account_id: { type: "string" },
        since_date: { type: "string" },
      },
    },
  },
  {
    name: "import_transactions",
    group: "transactions",
    write: true,
    endpoints: [
      ep("POST", "/budgets/{budget_id}/transactions/import", "Transactions", "importTransactions"),
    ],
    description:
      "Trigger direct import on accounts already bank-linked in the YNAB app (pull latest bank activity). Returns newly imported transaction ids. Cannot create the link itself.",
    inputSchema: { type: "object", properties: { ...budgetIdProp } },
  },
  {
    name: "spending_summary",
    group: "transactions",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/transactions", "Transactions", "getTransactions")],
    description:
      "Aggregate spending by category or payee over a date range — totals, units, and counts per group. Cheaper than listing every row.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        group_by: { type: "string", enum: ["category", "payee"], default: "category" },
        account_id: { type: "string" },
        since_date: { type: "string" },
        until_date: { type: "string" },
      },
    },
  },
  {
    name: "payee_transactions",
    group: "transactions",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/payees/{payee_id}/transactions",
        "Transactions",
        "getTransactionsByPayee",
      ),
    ],
    description: "Transaction history for one payee (drill-down for spending habits).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        payee_id: { type: "string" },
        since_date: { type: "string" },
        until_date: { type: "string" },
        type: { type: "string", enum: ["uncategorized", "unapproved"] },
        last_knowledge_of_server: { type: "number" },
      },
      required: ["payee_id"],
    },
  },
  {
    name: "category_transactions",
    group: "transactions",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/categories/{category_id}/transactions",
        "Transactions",
        "getTransactionsByCategory",
      ),
    ],
    description: "Transaction history for one category (drill-down for spending habits).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        category_id: { type: "string" },
        since_date: { type: "string" },
        until_date: { type: "string" },
        type: { type: "string", enum: ["uncategorized", "unapproved"] },
        last_knowledge_of_server: { type: "number" },
      },
      required: ["category_id"],
    },
  },
  {
    name: "list_months",
    group: "months",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/months", "Months", "getPlanMonths")],
    description: "List budget months with income/budgeted/activity/to-be-budgeted summaries.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, last_knowledge_of_server: { type: "number" } },
    },
  },
  {
    name: "get_month",
    group: "months",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/months/{month}", "Months", "getPlanMonth")],
    description: 'Get one budget month (default "current") with its category breakdown.',
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        month: { type: "string", description: '"YYYY-MM-01" or "current".', default: "current" },
      },
    },
  },
  {
    name: "list_payees",
    group: "payees",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/payees", "Payees", "getPayees")],
    description: "List payees in a budget.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, last_knowledge_of_server: { type: "number" } },
    },
  },
  {
    name: "create_payee",
    group: "payees",
    write: true,
    endpoints: [ep("POST", "/budgets/{budget_id}/payees", "Payees", "createPayee")],
    description: "Create a payee.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "list_scheduled_transactions",
    group: "scheduled",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/scheduled_transactions",
        "ScheduledTransactions",
        "getScheduledTransactions",
      ),
    ],
    description: "List scheduled (recurring/upcoming) transactions with next date and frequency.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, last_knowledge_of_server: { type: "number" } },
    },
  },
  {
    name: "get_scheduled_transaction",
    group: "scheduled",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/scheduled_transactions/{scheduled_transaction_id}",
        "ScheduledTransactions",
        "getScheduledTransactionById",
      ),
    ],
    description: "Get a single scheduled transaction by id.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, scheduled_transaction_id: { type: "string" } },
      required: ["scheduled_transaction_id"],
    },
  },
  {
    name: "create_scheduled_transaction",
    group: "scheduled",
    write: true,
    endpoints: [
      ep(
        "POST",
        "/budgets/{budget_id}/scheduled_transactions",
        "ScheduledTransactions",
        "createScheduledTransaction",
      ),
    ],
    description:
      "Create a scheduled (recurring) transaction. amount is milliunits (negative = outflow).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        account_id: { type: "string" },
        date: { type: "string", description: "ISO date of the first occurrence." },
        amount: { type: "number", description: "Milliunits; negative outflow, positive inflow." },
        frequency: {
          type: "string",
          enum: [
            "never",
            "daily",
            "weekly",
            "everyOtherWeek",
            "twiceAMonth",
            "every4Weeks",
            "monthly",
            "everyOtherMonth",
            "every3Months",
            "every4Months",
            "twiceAYear",
            "yearly",
            "everyOtherYear",
          ],
        },
        payee_id: { type: "string" },
        payee_name: { type: "string" },
        category_id: { type: "string" },
        memo: { type: "string" },
        flag_color: {
          type: "string",
          enum: ["red", "orange", "yellow", "green", "blue", "purple"],
        },
      },
      required: ["account_id", "date", "amount", "frequency"],
    },
  },
  {
    name: "update_scheduled_transaction",
    group: "scheduled",
    write: true,
    endpoints: [
      ep(
        "PUT",
        "/budgets/{budget_id}/scheduled_transactions/{scheduled_transaction_id}",
        "ScheduledTransactions",
        "updateScheduledTransaction",
      ),
    ],
    description:
      "Update fields on an existing scheduled transaction (only provided fields change).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        scheduled_transaction_id: { type: "string" },
        date: { type: "string" },
        amount: { type: "number", description: "Milliunits." },
        frequency: {
          type: "string",
          enum: [
            "never",
            "daily",
            "weekly",
            "everyOtherWeek",
            "twiceAMonth",
            "every4Weeks",
            "monthly",
            "everyOtherMonth",
            "every3Months",
            "every4Months",
            "twiceAYear",
            "yearly",
            "everyOtherYear",
          ],
        },
        payee_id: { type: "string" },
        payee_name: { type: "string" },
        category_id: { type: "string" },
        memo: { type: "string" },
        flag_color: {
          type: "string",
          enum: ["red", "orange", "yellow", "green", "blue", "purple"],
        },
      },
      required: ["scheduled_transaction_id"],
    },
  },
  {
    name: "delete_scheduled_transaction",
    group: "scheduled",
    write: true,
    endpoints: [
      ep(
        "DELETE",
        "/budgets/{budget_id}/scheduled_transactions/{scheduled_transaction_id}",
        "ScheduledTransactions",
        "deleteScheduledTransaction",
      ),
    ],
    description: "Delete a scheduled transaction by id.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, scheduled_transaction_id: { type: "string" } },
      required: ["scheduled_transaction_id"],
    },
  },
  {
    name: "get_user",
    group: "budgets",
    write: false,
    endpoints: [ep("GET", "/user", "User", "getUser")],
    description: "Get the authenticated YNAB user's id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_payee",
    group: "payees",
    write: false,
    endpoints: [ep("GET", "/budgets/{budget_id}/payees/{payee_id}", "Payees", "getPayeeById")],
    description: "Get one payee by id.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, payee_id: { type: "string" } },
      required: ["payee_id"],
    },
  },
  {
    name: "update_payee",
    group: "payees",
    write: true,
    endpoints: [ep("PATCH", "/budgets/{budget_id}/payees/{payee_id}", "Payees", "updatePayee")],
    description: "Rename a payee.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, payee_id: { type: "string" }, name: { type: "string" } },
      required: ["payee_id", "name"],
    },
  },
  {
    name: "list_payee_locations",
    group: "payees",
    write: false,
    endpoints: [
      ep("GET", "/budgets/{budget_id}/payee_locations", "PayeeLocations", "getPayeeLocations"),
    ],
    description: "List all payee GPS locations (set by the YNAB mobile app).",
    inputSchema: { type: "object", properties: { ...budgetIdProp } },
  },
  {
    name: "get_payee_location",
    group: "payees",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/payee_locations/{payee_location_id}",
        "PayeeLocations",
        "getPayeeLocationById",
      ),
    ],
    description: "Get one payee location by id.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, payee_location_id: { type: "string" } },
      required: ["payee_location_id"],
    },
  },
  {
    name: "payee_locations",
    group: "payees",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/payees/{payee_id}/payee_locations",
        "PayeeLocations",
        "getPayeeLocationsByPayee",
      ),
    ],
    description: "List the GPS locations recorded for one payee.",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, payee_id: { type: "string" } },
      required: ["payee_id"],
    },
  },
  {
    name: "get_month_category",
    group: "categories",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/months/{month}/categories/{category_id}",
        "Categories",
        "getMonthCategoryById",
      ),
    ],
    description: "Get one category's figures for a specific month (budgeted/activity/balance).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        month: { type: "string", description: 'ISO month or "current". Defaults to current.' },
        category_id: { type: "string" },
      },
      required: ["category_id"],
    },
  },
  {
    name: "create_category",
    group: "categories",
    write: true,
    endpoints: [ep("POST", "/budgets/{budget_id}/categories", "Categories", "createCategory")],
    description:
      "Create a category in a category group (newer YNAB endpoint; verify availability on your plan).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        name: { type: "string" },
        category_group_id: { type: "string" },
        goal_target: { type: "number" },
        goal_target_date: { type: "string" },
        goal_needs_whole_amount: { type: "boolean" },
      },
      required: ["name", "category_group_id"],
    },
  },
  {
    name: "update_category",
    group: "categories",
    write: true,
    endpoints: [
      ep("PATCH", "/budgets/{budget_id}/categories/{category_id}", "Categories", "updateCategory"),
    ],
    description:
      "Rename a category, set its note, and/or MOVE it to another group via category_group_id (newer YNAB endpoint). Note: YNAB has no API for reordering categories within a group.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        category_id: { type: "string" },
        name: { type: "string" },
        note: { type: "string" },
        category_group_id: { type: "string", description: "Move the category into this group." },
        goal_target: { type: "number" },
        goal_target_date: { type: "string" },
        goal_needs_whole_amount: { type: "boolean" },
      },
      required: ["category_id"],
    },
  },
  {
    name: "create_category_group",
    group: "categories",
    write: true,
    endpoints: [
      ep("POST", "/budgets/{budget_id}/category_groups", "Categories", "createCategoryGroup"),
    ],
    description: "Create a category group (newer YNAB endpoint; verify availability on your plan).",
    inputSchema: {
      type: "object",
      properties: { ...budgetIdProp, name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "update_category_group",
    group: "categories",
    write: true,
    endpoints: [
      ep(
        "PATCH",
        "/budgets/{budget_id}/category_groups/{category_group_id}",
        "Categories",
        "updateCategoryGroup",
      ),
    ],
    description: "Rename a category group (newer YNAB endpoint).",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        category_group_id: { type: "string" },
        name: { type: "string" },
      },
      required: ["category_group_id", "name"],
    },
  },
  {
    name: "month_transactions",
    group: "transactions",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/months/{month}/transactions",
        "Transactions",
        "getTransactionsByMonth",
      ),
    ],
    description: "List transactions for a specific budget month.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        month: { type: "string", description: 'ISO month or "current". Defaults to current.' },
        since_date: { type: "string" },
        until_date: { type: "string" },
        type: { type: "string", enum: ["uncategorized", "unapproved"] },
        last_knowledge_of_server: { type: "number" },
      },
    },
  },
  {
    name: "list_money_movements",
    group: "money_movements",
    write: false,
    endpoints: [
      ep("GET", "/budgets/{budget_id}/money_movements", "MoneyMovements", "getMoneyMovements"),
    ],
    description: "List money movements in a budget.",
    inputSchema: { type: "object", properties: { ...budgetIdProp } },
  },
  {
    name: "month_money_movements",
    group: "money_movements",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/months/{month}/money_movements",
        "MoneyMovements",
        "getMoneyMovementsByMonth",
      ),
    ],
    description: "List money movements for a specific budget month.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        month: { type: "string", description: 'ISO month or "current". Defaults to current.' },
      },
    },
  },
  {
    name: "list_money_movement_groups",
    group: "money_movements",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/money_movement_groups",
        "MoneyMovements",
        "getMoneyMovementGroups",
      ),
    ],
    description: "List money movement groups in a budget.",
    inputSchema: { type: "object", properties: { ...budgetIdProp } },
  },
  {
    name: "month_money_movement_groups",
    group: "money_movements",
    write: false,
    endpoints: [
      ep(
        "GET",
        "/budgets/{budget_id}/months/{month}/money_movement_groups",
        "MoneyMovements",
        "getMoneyMovementGroupsByMonth",
      ),
    ],
    description: "List money movement groups for a specific budget month.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        month: { type: "string", description: 'ISO month or "current". Defaults to current.' },
      },
    },
  },
  {
    name: "bulk_create_transactions",
    group: "transactions",
    write: true,
    endpoints: [
      ep("POST", "/budgets/{budget_id}/transactions", "Transactions", "createTransaction"),
    ],
    description:
      "Create MANY transactions in one call (POST array). Each item needs account_id, date, amount; optional category_id, payee, memo, import_id, and subtransactions[] for splits. Returns created ids + any duplicate_import_ids.",
    inputSchema: {
      type: "object",
      properties: {
        ...budgetIdProp,
        transactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              account_id: { type: "string" },
              date: { type: "string" },
              amount: { type: "number", description: "Milliunits; negative outflow." },
              import_id: { type: "string" },
              subtransactions: {
                type: "array",
                items: { type: "object", properties: subtransactionProps, required: ["amount"] },
              },
              ...txnFieldProps,
            },
            required: ["account_id", "date", "amount"],
          },
        },
      },
      required: ["transactions"],
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function enabledToolNames(ctx: ToolContext): Set<string> {
  return new Set(TOOLS.filter((t) => isToolEnabledForContext(ctx, t)).map((t) => t.name));
}

export function isToolEnabledForContext(ctx: ToolContext, tool: ToolDef): boolean {
  if (!isToolEnabled(ctx.enabledGroups, ctx.readOnly, tool.group, tool.write)) return false;
  if (tool.name === "set_transaction_cleared") return ctx.writePolicy === "clear-status";
  if (tool.name === "set_transaction_category")
    return ctx.writePolicy === "clear-status" && !!ctx.categoryWriteBudget;
  if (tool.name === "approve_transaction")
    return ctx.writePolicy === "clear-status" && !!ctx.approvalWriteBudget;
  if (tool.name === "reconcile_account")
    return ctx.writePolicy === "clear-status" && !!ctx.reconciliationWriteBudget;
  return !(ctx.writePolicy === "clear-status" && tool.write);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function withServerKnowledge<T>(
  lastKnowledge: number | undefined,
  serverKnowledge: number | undefined,
  key: string,
  rows: T,
): T | { server_knowledge: number | undefined; [k: string]: unknown } {
  if (lastKnowledge === undefined) return rows;
  return { server_knowledge: serverKnowledge, [key]: rows };
}

export async function handleTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
): Promise<string> {
  if (!enabledToolNames(ctx).has(name)) {
    throw new Error(
      `Tool "${name}" is not enabled. Adjust YNAB_TOOLSETS / YNAB_READ_ONLY to enable it.`,
    );
  }
  const { client } = ctx;
  const budget = (args: { budget_id?: string }) =>
    (args.budget_id ?? "").trim() || ctx.defaultBudget;

  switch (name) {
    case "set_transaction_cleared": {
      const args = SetTransactionClearedInput.parse(rawArgs);
      if (!ctx.clearedWriteBudget)
        throw new Error("No budget approved for cleared-status changes.");
      if (args.budget_id && args.budget_id !== ctx.clearedWriteBudget) {
        throw new Error("Cleared-status changes are not enabled for this budget.");
      }
      const targetBudget = ctx.clearedWriteBudget;
      const current = await client.getTransaction(targetBudget, args.transaction_id);
      if (current.deleted || current.cleared === "reconciled") {
        throw new Error("Deleted or reconciled transactions cannot be changed by this tool.");
      }
      if (current.cleared === args.cleared) return json(formatTransaction(current));
      return json(
        formatTransaction(
          await client.updateTransaction(targetBudget, args.transaction_id, {
            cleared: args.cleared,
          }),
        ),
      );
    }
    case "set_transaction_category": {
      const args = SetTransactionCategoryInput.parse(rawArgs);
      const targetBudget = ctx.categoryWriteBudget;
      if (!targetBudget || (args.budget_id && args.budget_id !== targetBudget)) {
        throw new Error("Category changes are not enabled for this budget.");
      }
      const current = await client.getTransaction(targetBudget, args.transaction_id);
      if (
        current.id !== args.transaction_id ||
        current.deleted ||
        current.cleared === "reconciled"
      ) {
        throw new Error(
          "Deleted, reconciled, or mismatched transactions cannot be changed by this tool.",
        );
      }
      if (
        current.transfer_account_id ||
        current.transfer_transaction_id ||
        current.subtransactions.length
      ) {
        throw new Error("Transfers and split transactions cannot be changed by this tool.");
      }
      if (current.category_id !== args.expected_category_id) {
        throw new Error(
          "Transaction category changed since review. Fetch it again before retrying.",
        );
      }
      const category = await client.getCategory(targetBudget, args.category_id);
      if (
        category.id !== args.category_id ||
        category.deleted ||
        category.hidden ||
        category.internal === true ||
        category.category_group_name === "Internal Master Category"
      ) {
        throw new Error("Target category must be an active ordinary category.");
      }
      if (current.category_id === args.category_id) return json(formatTransaction(current));
      return json(
        formatTransaction(
          await client.updateTransaction(targetBudget, args.transaction_id, {
            category_id: args.category_id,
          }),
        ),
      );
    }
    case "approve_transaction": {
      const args = ApproveTransactionInput.parse(rawArgs);
      const targetBudget = ctx.approvalWriteBudget;
      if (!targetBudget || (args.budget_id && args.budget_id !== targetBudget)) {
        throw new Error("Transaction approval is not enabled for this budget.");
      }
      const current = await client.getTransaction(targetBudget, args.transaction_id);
      if (
        current.id !== args.transaction_id ||
        current.deleted ||
        current.cleared === "reconciled"
      ) {
        throw new Error(
          "Deleted, reconciled, or mismatched transactions cannot be approved by this tool.",
        );
      }
      if (
        current.transfer_account_id ||
        current.transfer_transaction_id ||
        current.subtransactions.length
      ) {
        throw new Error("Transfers and split transactions cannot be approved by this tool.");
      }
      if (current.category_id !== args.expected_category_id) {
        throw new Error(
          "Transaction category changed since review. Fetch it again before approving.",
        );
      }
      if (current.approved) return json(formatTransaction(current));
      return json(
        formatTransaction(
          await client.updateTransaction(targetBudget, args.transaction_id, { approved: true }),
        ),
      );
    }
    case "preview_account_reconciliation": {
      const args = AccountReconciliationInput.parse(rawArgs);
      return json((await readReconciliationPlan(client, budget(args), args)).preview);
    }
    case "reconcile_account": {
      const args = ApplyAccountReconciliationInput.parse(rawArgs);
      const targetBudget = ctx.reconciliationWriteBudget;
      if (!targetBudget || (args.budget_id && args.budget_id !== targetBudget))
        throw new Error("Reconciliation is not enabled for this budget.");
      return json(await applyReconciliation(client, targetBudget, args, args.plan_id));
    }
    case "list_budgets": {
      const args = ListBudgetsInput.parse(rawArgs);
      const budgets = await client.listBudgets({
        ...(args.include_accounts !== undefined && { include_accounts: args.include_accounts }),
      });
      return json(
        budgets.map((b) => ({
          currency: b.currency_format?.iso_code ?? "",
          ...b,
          ...(Array.isArray(b.accounts) ? { accounts: b.accounts.map(formatAccount) } : {}),
        })),
      );
    }
    case "get_budget": {
      const args = BudgetDeltaArg.parse(rawArgs);
      return json(
        await client.getBudget(budget(args), {
          ...(args.last_knowledge_of_server !== undefined && {
            last_knowledge_of_server: args.last_knowledge_of_server,
          }),
        }),
      );
    }
    case "budget_settings": {
      const args = BudgetArg.parse(rawArgs);
      return json(await client.getBudgetSettings(budget(args)));
    }
    case "list_accounts": {
      const args = BudgetDeltaArg.parse(rawArgs);
      const result = await client.listAccounts(budget(args), {
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "accounts",
          result.accounts.filter((a) => !a.deleted).map(formatAccount),
        ),
      );
    }
    case "get_account": {
      const args = AccountRef.parse(rawArgs);
      return json(formatAccount(await client.getAccount(budget(args), args.account_id)));
    }
    case "create_account": {
      const args = CreateAccountInput.parse(rawArgs);
      const account = await client.createAccount(budget(args), {
        name: args.name,
        type: args.type,
        balance: args.balance,
      });
      return json(formatAccount(account));
    }
    case "list_categories": {
      const args = BudgetDeltaArg.parse(rawArgs);
      const result = await client.listCategories(budget(args), {
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "category_groups",
          result.category_groups
            .filter((g) => !g.deleted && !g.hidden)
            .map((g) => ({
              ...formatCategoryGroup(g),
              group: g.name,
              categories: g.categories.filter((c) => !c.deleted && !c.hidden).map(formatCategory),
            })),
        ),
      );
    }
    case "get_category": {
      const args = CategoryRef.parse(rawArgs);
      return json(formatCategory(await client.getCategory(budget(args), args.category_id)));
    }
    case "update_category_budget": {
      const args = UpdateCategoryBudgetInput.parse(rawArgs);
      const category = await client.updateCategoryBudget(
        budget(args),
        args.month,
        args.category_id,
        args.budgeted,
      );
      return json(formatCategory(category));
    }
    case "list_transactions": {
      const args = ListTransactionsInput.parse(rawArgs);
      const result = await client.listTransactions(budget(args), {
        ...(args.account_id !== undefined && { account_id: args.account_id }),
        ...(args.since_date !== undefined && { since_date: args.since_date }),
        ...(args.until_date !== undefined && { until_date: args.until_date }),
        ...(args.type !== undefined && { type: args.type }),
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      const out = result.transactions
        .filter((t) => !t.deleted)
        .slice(-args.max_results)
        .map(formatTransaction);
      return out.length > 0
        ? json(
            withServerKnowledge(
              args.last_knowledge_of_server,
              result.server_knowledge,
              "transactions",
              out,
            ),
          )
        : "No transactions found.";
    }
    case "get_transaction": {
      const args = TransactionRef.parse(rawArgs);
      return json(
        formatTransaction(await client.getTransaction(budget(args), args.transaction_id)),
      );
    }
    case "create_transaction": {
      const args = CreateTransactionInput.parse(rawArgs);
      const { budget_id: _b, ...fields } = args;
      return json(formatTransaction(await client.createTransaction(budget(args), fields)));
    }
    case "update_transaction": {
      const args = UpdateTransactionInput.parse(rawArgs);
      const { budget_id: _b, transaction_id, ...fields } = args;
      return json(
        formatTransaction(await client.updateTransaction(budget(args), transaction_id, fields)),
      );
    }
    case "bulk_update_transactions": {
      const args = BulkUpdateInput.parse(rawArgs);
      const result = await client.bulkUpdateTransactions(budget(args), args.updates);
      return json({
        updated: result.transaction_ids.length,
        transaction_ids: result.transaction_ids,
        transactions: result.transactions.map(formatTransaction),
      });
    }
    case "delete_transaction": {
      const args = TransactionRef.parse(rawArgs);
      const deleted = await client.deleteTransaction(budget(args), args.transaction_id);
      return json({ deleted: true, transaction: formatTransaction(deleted) });
    }
    case "find_duplicate_transactions": {
      const args = FindDuplicatesInput.parse(rawArgs);
      const result = await client.listTransactions(budget(args), {
        ...(args.account_id !== undefined && { account_id: args.account_id }),
        ...(args.since_date !== undefined && { since_date: args.since_date }),
      });
      const candidates: DupTxn[] = result.transactions
        .filter((t) => !t.deleted)
        .map((t) => ({
          id: t.id,
          account_id: t.account_id,
          amount: t.amount,
          date: t.date,
          import_id: t.import_id,
          payee_name: t.payee_name,
        }));
      const clusters = findDuplicateTransactions(candidates);
      return clusters.length > 0 ? json(clusters) : "No duplicate transactions found.";
    }
    case "import_transactions": {
      const args = BudgetArg.parse(rawArgs);
      const ids = await client.importTransactions(budget(args));
      return json({ imported: ids.length, transaction_ids: ids });
    }
    case "spending_summary": {
      const args = SpendingSummaryInput.parse(rawArgs);
      const result = await client.listTransactions(budget(args), {
        ...(args.account_id !== undefined && { account_id: args.account_id }),
        ...(args.since_date !== undefined && { since_date: args.since_date }),
        ...(args.until_date !== undefined && { until_date: args.until_date }),
      });
      const summaryTxns: SummaryTxn[] = result.transactions
        .filter((t) => !t.deleted)
        .map((t) => ({
          amount: t.amount,
          category_name: t.category_name,
          payee_name: t.payee_name,
        }));
      return json(summarizeSpending(summaryTxns, args.group_by));
    }
    case "payee_transactions": {
      const args = PayeeTxnsInput.parse(rawArgs);
      const result = await client.listPayeeTransactions(budget(args), args.payee_id, {
        ...(args.since_date !== undefined && { since_date: args.since_date }),
        ...(args.until_date !== undefined && { until_date: args.until_date }),
        ...(args.type !== undefined && { type: args.type }),
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "transactions",
          result.transactions.filter((t) => !t.deleted).map(formatTransaction),
        ),
      );
    }
    case "category_transactions": {
      const args = CategoryTxnsInput.parse(rawArgs);
      const result = await client.listCategoryTransactions(budget(args), args.category_id, {
        ...(args.since_date !== undefined && { since_date: args.since_date }),
        ...(args.until_date !== undefined && { until_date: args.until_date }),
        ...(args.type !== undefined && { type: args.type }),
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "transactions",
          result.transactions.filter((t) => !t.deleted).map(formatTransaction),
        ),
      );
    }
    case "list_months": {
      const args = BudgetDeltaArg.parse(rawArgs);
      const result = await client.listMonths(budget(args), {
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "months",
          result.months.filter((m) => !m.deleted).map(formatMonth),
        ),
      );
    }
    case "get_month": {
      const args = MonthRef.parse(rawArgs);
      const m = await client.getMonth(budget(args), args.month);
      return json({
        ...formatMonth(m),
        categories: m.categories.filter((c) => !c.deleted && !c.hidden).map(formatCategory),
      });
    }
    case "list_payees": {
      const args = BudgetDeltaArg.parse(rawArgs);
      const result = await client.listPayees(budget(args), {
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "payees",
          result.payees.filter((p) => !p.deleted).map(formatPayee),
        ),
      );
    }
    case "create_payee": {
      const args = CreatePayeeInput.parse(rawArgs);
      return json(formatPayee(await client.createPayee(budget(args), args.name)));
    }
    case "list_scheduled_transactions": {
      const args = BudgetDeltaArg.parse(rawArgs);
      const result = await client.listScheduledTransactions(budget(args), {
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "scheduled_transactions",
          result.scheduled_transactions.filter((s) => !s.deleted).map(formatScheduledTransaction),
        ),
      );
    }
    case "get_scheduled_transaction": {
      const args = ScheduledTxnRef.parse(rawArgs);
      const s = await client.getScheduledTransaction(budget(args), args.scheduled_transaction_id);
      return json(formatScheduledTransaction(s));
    }
    case "create_scheduled_transaction": {
      const args = CreateScheduledTxnInput.parse(rawArgs);
      const fields: SaveScheduledTxnFields = {
        account_id: args.account_id,
        date: args.date,
        amount: args.amount,
        frequency: args.frequency,
        payee_id: args.payee_id,
        payee_name: args.payee_name,
        category_id: args.category_id,
        memo: args.memo,
        flag_color: args.flag_color,
      };
      const s = await client.createScheduledTransaction(budget(args), fields);
      return json(formatScheduledTransaction(s));
    }
    case "update_scheduled_transaction": {
      const args = UpdateScheduledTxnInput.parse(rawArgs);
      const fields: SaveScheduledTxnFields = {
        date: args.date,
        amount: args.amount,
        frequency: args.frequency,
        payee_id: args.payee_id,
        payee_name: args.payee_name,
        category_id: args.category_id,
        memo: args.memo,
        flag_color: args.flag_color,
      };
      const s = await client.updateScheduledTransaction(
        budget(args),
        args.scheduled_transaction_id,
        fields,
      );
      return json(formatScheduledTransaction(s));
    }
    case "delete_scheduled_transaction": {
      const args = ScheduledTxnRef.parse(rawArgs);
      const s = await client.deleteScheduledTransaction(
        budget(args),
        args.scheduled_transaction_id,
      );
      return json(formatScheduledTransaction(s));
    }
    case "get_user": {
      return json({ id: (await client.getUser()).id });
    }
    case "get_payee": {
      const args = PayeeRef.parse(rawArgs);
      return json(formatPayee(await client.getPayee(budget(args), args.payee_id)));
    }
    case "update_payee": {
      const args = UpdatePayeeInput.parse(rawArgs);
      return json(formatPayee(await client.updatePayee(budget(args), args.payee_id, args.name)));
    }
    case "list_payee_locations": {
      const args = BudgetArg.parse(rawArgs);
      const locations = await client.listPayeeLocations(budget(args));
      return json(locations.filter((l) => !l.deleted).map(formatPayeeLocation));
    }
    case "get_payee_location": {
      const args = PayeeLocationRef.parse(rawArgs);
      return json(
        formatPayeeLocation(await client.getPayeeLocation(budget(args), args.payee_location_id)),
      );
    }
    case "payee_locations": {
      const args = PayeeRef.parse(rawArgs);
      const locations = await client.listPayeeLocationsForPayee(budget(args), args.payee_id);
      return json(locations.filter((l) => !l.deleted).map(formatPayeeLocation));
    }
    case "get_month_category": {
      const args = MonthCategoryRef.parse(rawArgs);
      return json(
        formatCategory(await client.getMonthCategory(budget(args), args.month, args.category_id)),
      );
    }
    case "create_category": {
      const args = CreateCategoryInput.parse(rawArgs);
      const category = await client.createCategory(budget(args), {
        name: args.name,
        category_group_id: args.category_group_id,
        goal_target: args.goal_target,
        goal_target_date: args.goal_target_date,
        goal_needs_whole_amount: args.goal_needs_whole_amount,
      });
      return json(formatCategory(category));
    }
    case "update_category": {
      const args = UpdateCategoryInput.parse(rawArgs);
      const category = await client.updateCategory(budget(args), args.category_id, {
        name: args.name,
        note: args.note,
        category_group_id: args.category_group_id,
        goal_target: args.goal_target,
        goal_target_date: args.goal_target_date,
        goal_needs_whole_amount: args.goal_needs_whole_amount,
      });
      return json(formatCategory(category));
    }
    case "create_category_group": {
      const args = CreateCategoryGroupInput.parse(rawArgs);
      return json(formatCategoryGroup(await client.createCategoryGroup(budget(args), args.name)));
    }
    case "update_category_group": {
      const args = UpdateCategoryGroupInput.parse(rawArgs);
      return json(
        formatCategoryGroup(
          await client.updateCategoryGroup(budget(args), args.category_group_id, args.name),
        ),
      );
    }
    case "month_transactions": {
      const args = MonthTxnsInput.parse(rawArgs);
      const result = await client.listMonthTransactions(budget(args), args.month, {
        ...(args.since_date !== undefined && { since_date: args.since_date }),
        ...(args.until_date !== undefined && { until_date: args.until_date }),
        ...(args.type !== undefined && { type: args.type }),
        ...(args.last_knowledge_of_server !== undefined && {
          last_knowledge_of_server: args.last_knowledge_of_server,
        }),
      });
      return json(
        withServerKnowledge(
          args.last_knowledge_of_server,
          result.server_knowledge,
          "transactions",
          result.transactions.filter((t) => !t.deleted).map(formatTransaction),
        ),
      );
    }
    case "list_money_movements": {
      const args = BudgetArg.parse(rawArgs);
      const result = await client.listMoneyMovements(budget(args));
      return json({
        server_knowledge: result.server_knowledge,
        money_movements: result.money_movements.map(formatMoneyMovement),
      });
    }
    case "month_money_movements": {
      const args = MoneyMovementMonthInput.parse(rawArgs);
      const result = await client.listMonthMoneyMovements(budget(args), args.month);
      return json({
        server_knowledge: result.server_knowledge,
        money_movements: result.money_movements.map(formatMoneyMovement),
      });
    }
    case "list_money_movement_groups": {
      const args = BudgetArg.parse(rawArgs);
      const result = await client.listMoneyMovementGroups(budget(args));
      return json({
        server_knowledge: result.server_knowledge,
        money_movement_groups: result.money_movement_groups.map(formatMoneyMovementGroup),
      });
    }
    case "month_money_movement_groups": {
      const args = MoneyMovementMonthInput.parse(rawArgs);
      const result = await client.listMonthMoneyMovementGroups(budget(args), args.month);
      return json({
        server_knowledge: result.server_knowledge,
        money_movement_groups: result.money_movement_groups.map(formatMoneyMovementGroup),
      });
    }
    case "bulk_create_transactions": {
      const args = BulkCreateInput.parse(rawArgs);
      const result = await client.bulkCreateTransactions(budget(args), args.transactions);
      return json({
        created: result.transaction_ids.length,
        transaction_ids: result.transaction_ids,
        transactions: result.transactions.map(formatTransaction),
        duplicate_import_ids: result.duplicate_import_ids,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
