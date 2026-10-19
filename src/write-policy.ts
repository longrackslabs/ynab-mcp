/** Optional Node HTTP policy. An unset policy preserves upstream permissions. */
export function parseWritePolicy(env: Record<string, string | undefined>) {
  const policy = env["YNAB_WRITE_POLICY"]?.trim();
  if (policy && policy !== "clear-status") {
    throw new Error("Unknown YNAB_WRITE_POLICY. Use clear-status or leave it unset.");
  }
  const clearStatusOnly = policy === "clear-status";
  const clearedWriteBudget = env["YNAB_CLEARED_WRITE_BUDGET"]?.trim() || undefined;
  const categoryWriteBudget = env["YNAB_CATEGORY_WRITE_BUDGET"]?.trim() || undefined;
  const approvalWriteBudget = env["YNAB_APPROVAL_WRITE_BUDGET"]?.trim() || undefined;
  const reconciliationWriteBudget = env["YNAB_RECONCILIATION_WRITE_BUDGET"]?.trim() || undefined;
  if (
    !clearStatusOnly &&
    (clearedWriteBudget || categoryWriteBudget || approvalWriteBudget || reconciliationWriteBudget)
  ) {
    throw new Error("Restricted write budget settings require YNAB_WRITE_POLICY=clear-status.");
  }
  if (clearStatusOnly && !clearedWriteBudget) {
    throw new Error("YNAB_CLEARED_WRITE_BUDGET is required for the restricted policy.");
  }
  if (categoryWriteBudget && categoryWriteBudget !== clearedWriteBudget) {
    throw new Error("Category writes require the same approved budget.");
  }
  if (approvalWriteBudget && approvalWriteBudget !== clearedWriteBudget) {
    throw new Error("Transaction approval requires the same approved budget.");
  }
  if (reconciliationWriteBudget && reconciliationWriteBudget !== clearedWriteBudget)
    throw new Error("Reconciliation requires the same approved budget.");
  return {
    clearStatusOnly,
    clearedWriteBudget,
    categoryWriteBudget,
    approvalWriteBudget,
    reconciliationWriteBudget,
  };
}
