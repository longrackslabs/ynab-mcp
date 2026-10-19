import { createHash } from "node:crypto";

import type { YnabClient } from "./client.js";

export interface ReconciliationInput {
  account_id: string;
  bank_balance_milliunits: number;
}

function sum(values: number[]) {
  const total = values.reduce((a, b) => a + BigInt(b), 0n);
  const value = Number(total);
  if (!Number.isSafeInteger(value)) throw new Error("Balance exceeds safe integer range.");
  return value;
}

export async function readReconciliationPlan(
  client: YnabClient,
  budget: string,
  input: ReconciliationInput,
) {
  const [account, history] = await Promise.all([
    client.getAccount(budget, input.account_id),
    client.listTransactions(budget, { account_id: input.account_id, since_date: "1900-01-01" }),
  ]);
  if (account.id !== input.account_id || account.deleted || account.closed)
    throw new Error("Account is closed, deleted, or mismatched.");
  if (
    ![
      account.balance,
      account.cleared_balance,
      account.uncleared_balance,
      input.bank_balance_milliunits,
    ].every(Number.isSafeInteger)
  )
    throw new Error("Balances must be safe integer milliunits.");
  const rows = history.transactions
    .filter((t) => !t.deleted)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(rows.map((t) => t.id)).size !== rows.length)
    throw new Error("Duplicate transaction IDs in history.");
  if (
    rows.some(
      (t) =>
        t.account_id !== account.id ||
        !Number.isSafeInteger(t.amount) ||
        !["cleared", "uncleared", "reconciled"].includes(t.cleared),
    )
  )
    throw new Error("Invalid or cross-account history.");
  const pending = rows.filter((t) => t.cleared === "uncleared");
  const posted = rows.filter((t) => t.cleared !== "uncleared");
  if (
    sum(rows.map((t) => t.amount)) !== account.balance ||
    sum(posted.map((t) => t.amount)) !== account.cleared_balance ||
    sum(pending.map((t) => t.amount)) !== account.uncleared_balance ||
    sum([account.cleared_balance, account.uncleared_balance]) !== account.balance
  )
    throw new Error("History and account balances disagree. Refresh before reconciling.");
  const selected = rows.filter((t) => t.cleared === "cleared");
  const blockers: string[] = [];
  if (account.cleared_balance !== input.bank_balance_milliunits)
    blockers.push("Bank posted balance does not match YNAB cleared balance.");
  if (selected.some((t) => !t.approved))
    blockers.push("Review and approve all cleared entries before reconciling.");
  if (selected.length > 25)
    blockers.push(
      "More than 25 cleared entries; this version will not reconcile that many in one operation.",
    );
  const plan_id = createHash("sha256")
    .update(
      JSON.stringify({
        budget,
        input: {
          account_id: input.account_id,
          bank_balance_milliunits: input.bank_balance_milliunits,
        },
        account: {
          id: account.id,
          balance: account.balance,
          cleared: account.cleared_balance,
          uncleared: account.uncleared_balance,
          last_reconciled_at: account.last_reconciled_at,
        },
        rows,
      }),
    )
    .digest("hex");
  return {
    account,
    rows,
    selected,
    preview: {
      plan_id,
      account_id: account.id,
      bank_balance_milliunits: input.bank_balance_milliunits,
      cleared_balance_milliunits: account.cleared_balance,
      difference_milliunits: sum([input.bank_balance_milliunits, -account.cleared_balance]),
      can_reconcile: blockers.length === 0,
      blockers,
      already_reconciled: blockers.length === 0 && selected.length === 0,
      transaction_count: selected.length,
      transactions_truncated: selected.length > 25,
      transactions: selected.slice(0, 25).map((t) => ({
        id: t.id,
        date: t.date,
        payee: t.payee_name,
        amount: t.amount,
        approved: t.approved,
        cleared: t.cleared,
      })),
      uncleared_count: pending.length,
      uncleared_balance_milliunits: account.uncleared_balance,
      account_last_reconciled_at: account.last_reconciled_at ?? null,
      warnings: [
        "The bank balance must exclude pending activity. A balance match does not independently verify posting.",
        "The public API has no account reconciliation endpoint. This action marks cleared transactions reconciled; account reconciliation-date behavior is reported separately.",
      ],
    },
  };
}

function sameReview(a: Record<string, unknown>, b: Record<string, unknown>) {
  return (
    [
      "id",
      "account_id",
      "date",
      "amount",
      "payee_id",
      "category_id",
      "memo",
      "approved",
      "deleted",
      "transfer_account_id",
      "transfer_transaction_id",
      "flag_color",
      "import_id",
    ].every((k) => a[k] === b[k]) &&
    JSON.stringify(a.subtransactions) === JSON.stringify(b.subtransactions)
  );
}

export async function applyReconciliation(
  client: YnabClient,
  budget: string,
  input: ReconciliationInput,
  expectedPlan: string,
) {
  const plan = await readReconciliationPlan(client, budget, input);
  if (plan.preview.plan_id !== expectedPlan)
    throw new Error("Reconciliation preview is stale. Fetch and review a new preview.");
  if (!plan.preview.can_reconcile) throw new Error(plan.preview.blockers.join(" "));
  const attempted: string[] = [],
    completed: string[] = [];
  let failure: string | null = null;
  for (const row of plan.selected) {
    try {
      const [account, current] = await Promise.all([
        client.getAccount(budget, input.account_id),
        client.getTransaction(budget, row.id),
      ]);
      if (
        account.id !== input.account_id ||
        account.balance !== plan.account.balance ||
        account.cleared_balance !== plan.account.cleared_balance ||
        account.uncleared_balance !== plan.account.uncleared_balance ||
        account.deleted ||
        account.closed ||
        !sameReview(current, row) ||
        current.cleared !== "cleared"
      )
        throw new Error("Account or transaction changed after preview.");
      attempted.push(row.id);
      // Preserve the already-true approval flag; YNAB defaults omitted approval to false.
      const result = await client.updateTransaction(budget, row.id, {
        cleared: "reconciled",
        approved: true,
      });
      if (result.cleared !== "reconciled" || !sameReview(result, row))
        throw new Error("Unexpected transaction update result.");
      completed.push(row.id);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  try {
    const after = await readReconciliationPlan(client, budget, input);
    const byId = new Map(after.rows.map((t) => [t.id, t]));
    const verified = plan.selected
      .filter((t) => {
        const current = byId.get(t.id);
        return current && current.cleared === "reconciled" && sameReview(current, t);
      })
      .map((t) => t.id);
    const selectedIds = new Set(plan.selected.map((t) => t.id));
    const untouched =
      after.rows.length === plan.rows.length &&
      plan.rows
        .filter((t) => !selectedIds.has(t.id))
        .every((t) => {
          const current = byId.get(t.id);
          return current && current.cleared === t.cleared && sameReview(current, t);
        });
    const balancesUnchanged = ["balance", "cleared_balance", "uncleared_balance"].every(
      (k) => after.account[k] === plan.account[k],
    );
    return {
      status:
        !failure && verified.length === plan.selected.length && untouched && balancesUnchanged
          ? "transactions_reconciled"
          : "incomplete",
      account_id: input.account_id,
      attempted_ids: attempted,
      completed_ids: completed,
      verified_reconciled_ids: verified,
      failed_or_uncertain_ids: attempted.filter((id) => !verified.includes(id)),
      failure,
      balances_unchanged: balancesUnchanged,
      other_transactions_unchanged: untouched,
      account_last_reconciled_at: after.account.last_reconciled_at ?? null,
      account_reconciliation_date_changed:
        after.account.last_reconciled_at !== plan.account.last_reconciled_at,
      warning:
        "No account-level reconciliation endpoint was called. Transaction reconciliation and account reconciliation-date behavior are distinct. Do not retry incomplete operations without re-reading their state.",
    };
  } catch (error) {
    return {
      status: "verification_failed",
      account_id: input.account_id,
      attempted_ids: attempted,
      completed_ids: completed,
      failure,
      verification_error: error instanceof Error ? error.message : String(error),
      warning:
        "Some updates may have succeeded. Re-read before any retry; no automatic retries or reversals were attempted.",
    };
  }
}
