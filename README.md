# @redlinelabs/ynab-mcp

MCP server for [YNAB](https://www.ynab.com/) (You Need A Budget). Gives AI assistants (Claude
Desktop, Claude Code, etc.) tools to browse budgets, accounts, categories, transactions, and
months, and to make targeted edits (set a category's budgeted amount, create/update transactions).

> All monetary amounts in YNAB are **milliunits** — `1000` = one currency unit. Read tools return
> both the raw milliunit value and a human-friendly `*_units` sibling; write tools take milliunits.

> **Bank linking is not possible via the YNAB API** — it's a YNAB web/app-only feature. This server
> creates only _manual_ accounts; once you've linked a bank in the app, `import_transactions` can
> pull its latest activity. The API rate limit is **200 requests/hour** per token.

## Tools

Tools are organized into **toolsets** (groups) you can enable/disable — see
[Toolsets](#toolsets). `✏️` marks mutating (write) tools, which can be disabled all at once with
`YNAB_READ_ONLY`.

### `budgets`

| Tool              | Description                                   |
| ----------------- | --------------------------------------------- |
| `list_budgets`    | All budgets on the account                    |
| `get_budget`      | One full budget export, optionally as a delta |
| `budget_settings` | Currency + date-format settings for a budget  |

### `accounts`

| Tool                | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `list_accounts`     | Accounts in a budget, with balances                           |
| `get_account`       | One account by id                                             |
| `create_account` ✏️ | Create a **manual** account (API can't bank-link — see below) |

### `categories`

| Tool                        | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `list_categories`           | Category groups and their categories             |
| `get_category`              | One category by id                               |
| `update_category_budget` ✏️ | Set the budgeted amount (milliunits) for a month |

### `transactions`

| Tool                          | Description                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| `list_transactions`           | Transactions (filter by account/date/`uncategorized`/`unapproved`) |
| `get_transaction`             | One transaction by id                                              |
| `create_transaction` ✏️       | Create a transaction                                               |
| `update_transaction` ✏️       | Update fields on an existing transaction                           |
| `bulk_update_transactions` ✏️ | Categorize and/or approve **many** transactions in one call        |
| `delete_transaction` ✏️       | Delete a transaction (e.g. a confirmed duplicate)                  |
| `find_duplicate_transactions` | Find duplicate clusters (same account+amount+date) for review      |
| `import_transactions` ✏️      | Pull latest activity on already bank-linked accounts               |
| `spending_summary`            | Aggregate spend by category/payee over a date range                |
| `payee_transactions`          | Transaction history for one payee                                  |
| `category_transactions`       | Transaction history for one category                               |
| `month_transactions`          | Transaction history for one budget month                           |
| `list_money_movements`        | Money movements in a budget                                        |
| `month_money_movements`       | Money movements for one budget month                               |
| `list_money_movement_groups`  | Money movement groups in a budget                                  |
| `month_money_movement_groups` | Money movement groups for one budget month                         |

### `scheduled`

| Tool                          | Description                                   |
| ----------------------------- | --------------------------------------------- |
| `list_scheduled_transactions` | Recurring/upcoming transactions with next due |

### `months`

| Tool          | Description                                         |
| ------------- | --------------------------------------------------- |
| `list_months` | Budget months with income/budgeted/activity summary |
| `get_month`   | One month (default `current`) with category detail  |

### `payees`

| Tool              | Description        |
| ----------------- | ------------------ |
| `list_payees`     | Payees in a budget |
| `create_payee` ✏️ | Create a payee     |

### `money_movements`

| Tool                          | Description                                |
| ----------------------------- | ------------------------------------------ |
| `list_money_movements`        | Money movements in a budget                |
| `month_money_movements`       | Money movements for one budget month       |
| `list_money_movement_groups`  | Money movement groups in a budget          |
| `month_money_movement_groups` | Money movement groups for one budget month |

## Self-hosting the remote server (Docker)

The **primary** way to run this: a remote, multi-tenant OAuth server you host yourself. Anyone who
can reach it logs in with **their own** YNAB account (browser OAuth) and gets their own isolated,
read-only-by-default data — connect once and it stays connected (YNAB refresh tokens don't expire).
Reach it over Tailscale or your LAN. Full reference: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

OAuth needs HTTPS, so the server sits behind a stable HTTPS front. The bundled `docker-compose.yml`
runs the **prebuilt GHCR image** (`ghcr.io/redlinelabs-dev/ynab-mcp`) behind a **Tailscale sidecar**
that terminates HTTPS and serves it at `https://${TS_HOSTNAME}` — no reverse proxy, no clone. Give the
app its own directory holding just `docker-compose.yml` + `.env`:

```bash
mkdir ynab-mcp && cd ynab-mcp
curl -O https://raw.githubusercontent.com/redlinelabs-dev/ynab-mcp/main/docker-compose.yml

# YNAB OAuth app: Account Settings > Developer Settings > New OAuth Application,
# redirect URI = https://<TS_HOSTNAME>/callback   (e.g. https://ynab.your-tailnet.ts.net/callback)

cat > .env <<'ENV'
TS_HOSTNAME=ynab.your-tailnet.ts.net
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
YNAB_CLIENT_ID=your-ynab-oauth-client-id
YNAB_CLIENT_SECRET=your-ynab-oauth-client-secret
ENCRYPTION_KEY=base64-of-32-random-bytes      # openssl rand -base64 32
DATA_DIR=/mnt/HomeServer/Apps/ynab-mcp
ENV

docker compose up -d
curl -s https://${TS_HOSTNAME}/health         # {"status":"ok"}
```

GHCR packages are **private by default** (you'll get `unauthorized` on pull). Easiest fix: make the
package public — Org → Packages → `ynab-mcp` → Package settings → **Change visibility → Public** (safe;
the image has no secrets). Or keep it private and `sudo docker login ghcr.io -u <user>` on the host
first. Details + exact URL in [docs/DEPLOY.md](docs/DEPLOY.md). Pin a version tag —
`image: ghcr.io/redlinelabs-dev/ynab-mcp:v0.1.0` — for reproducible deploys.
Prefer to build instead of pull, or use a reverse proxy instead of Tailscale? Both are in
[docs/DEPLOY.md](docs/DEPLOY.md) (comments in `docker-compose.yml` cover the build option).

### Connect a client to your deployed server

Once it's up at `https://${TS_HOSTNAME}`, point any MCP client that supports **remote servers with
OAuth** at `https://${TS_HOSTNAME}/mcp`. There's nothing to configure beyond the URL — the server
supports dynamic client registration, so the client registers itself and you log in through the
browser (YNAB), choosing read-only or write on the consent screen. The connection then persists.

> The client machine must be able to reach `${TS_HOSTNAME}` — for a Tailscale deploy that means it's
> signed into the same tailnet. HTTPS is required (the deploy provides it).

**Claude Code**

```bash
claude mcp add --transport http ynab https://ynab.your-tailnet.ts.net/mcp
#   add  -s user  to make it available in every project (default: current project)
```

Then, in a session, run `/mcp` → **Authenticate** to do the browser OAuth login. Re-run `/mcp`
anytime to check status or re-authenticate.

**Claude Desktop**

Settings → **Connectors** → **Add custom connector**, name it `YNAB`, and enter the URL
`https://ynab.your-tailnet.ts.net/mcp`. Claude Desktop walks you through the OAuth login and the YNAB
tools appear once connected. (Needs a Claude Desktop version with custom-connector / remote-MCP
support.)

**Other clients** (Cursor, VS Code, hermes-agent, …)

Anything that speaks **remote / Streamable HTTP MCP** connects the same way — give it the URL and
complete the browser prompt. For clients configured by JSON, it's usually:

```json
{
  "mcpServers": {
    "ynab": { "type": "http", "url": "https://ynab.your-tailnet.ts.net/mcp" }
  }
}
```

**Headless clients without a browser** (e.g. an agent in a container) can skip OAuth entirely if you
set `YNAB_PAT_PASSTHROUGH=true` on the server: then `/mcp` also accepts a **YNAB Personal Access
Token** sent as a static bearer header — no flow, no expiry. In hermes that's just:

```yaml
mcp_servers:
  ynab:
    url: "https://ynab.your-tailnet.ts.net/mcp"
    headers:
      Authorization: "Bearer <your-YNAB-PAT>"
```

OAuth keeps working alongside it; the PAT path is per-request (each client uses its own token). Add
`YNAB_READ_ONLY=true` on the server to gate the PAT path to read-only.

## Setup (local stdio server)

This runs the server locally over stdio with a Personal Access Token — for single-user/dev use, or
clients that launch the process directly. (The remote Docker server above is the multi-user path.)

### Try it with no credentials (demo mode)

Set `YNAB_DEMO=1` and skip everything below — no YNAB account, no token. The server serves a
canned, entirely fictional **Demo Budget** (a checking/savings/credit-card account, category
groups, a few months of realistic transactions, and some scheduled transactions) from memory.
Writes (creating a transaction, budgeting a category, etc.) work and are reflected back for the
rest of the session, but nothing is persisted — the demo budget resets every time the process
restarts.

```bash
npm run build
YNAB_DEMO=1 node dist/index.js
```

Or point a client at it directly, e.g. for Claude Code:

```bash
claude mcp add --transport stdio --env YNAB_DEMO=1 ynab-demo -- node /absolute/path/to/ynab-mcp/dist/index.js
```

### 1. Create a YNAB Personal Access Token

In YNAB, go to **Account Settings → Developer Settings → New Token**.

### 2. Configure environment

Create a `.env` file (or pass env vars directly):

```env
YNAB_TOKEN=your-personal-access-token
YNAB_BUDGET_ID=last-used
```

- `YNAB_TOKEN` — your Personal Access Token (**required**, unless `YNAB_DEMO` is set)
- `YNAB_BUDGET_ID` — default budget for tools that omit `budget_id`. Accepts a budget UUID or an
  alias (`last-used`, `default`). Defaults to `last-used`.
- `YNAB_TOOLSETS` — optional comma-separated [toolsets](#toolsets) to expose (default: all)
- `YNAB_READ_ONLY` — optional; set to `true` to expose only read tools
- `YNAB_DEMO` — optional; set to `true`/`1` to run against a fictional Demo Budget with no token
  and no YNAB account (see [Try it with no credentials](#try-it-with-no-credentials-demo-mode))

> **Two ways to run this.** The instructions below are the **local, single-user stdio** server (a
> Personal Access Token on your own machine). For a **remote, multi-user OAuth** server you self-host
> (Docker on your homelab, reachable over Tailscale/LAN, each person logging in with their own YNAB
> account), see **[docs/DEPLOY.md](docs/DEPLOY.md)** — that is the primary deployment. This package is
> not published to npm; build it locally first with `npm install && npm run build`.

### 3. Add to Claude Code

After `npm run build`, point the client at the built stdio entry (`dist/index.js`):

```bash
claude mcp add --transport stdio \
  --env YNAB_TOKEN=your-personal-access-token \
  --env YNAB_BUDGET_ID=last-used \
  ynab -- node /absolute/path/to/ynab-mcp/dist/index.js
```

Env vars are scoped to the server process — no global environment setup needed.

### 4. Add to Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp/dist/index.js"],
      "env": {
        "YNAB_TOKEN": "your-personal-access-token",
        "YNAB_BUDGET_ID": "last-used"
      }
    }
  }
}
```

## Toolsets

To avoid bloating the model's context window, you can expose only the tool groups you need. Two
independent controls:

- **`YNAB_TOOLSETS`** — comma-separated group names, or `all` (default). Groups: `budgets`,
  `accounts`, `categories`, `transactions`, `months`, `payees`, `scheduled`, `money_movements`.
- **`YNAB_READ_ONLY`** — `true`/`1` exposes only non-mutating tools (drops every `✏️` tool).

```env
# Only read budgets, accounts, and transactions — never write:
YNAB_TOOLSETS=budgets,accounts,transactions
YNAB_READ_ONLY=true
```

Disabled tools are hidden from `tools/list` and rejected if called directly.

## Development

```bash
npm install
npm run dev        # watch mode
npm test           # run the Vitest suite
npm run check      # typecheck + lint + format check + tests
npm run build      # production build
```

Tests are unit/integration style against the public module interfaces, using an injected fake
`fetch` — they never touch the live YNAB API or the rate limit.

## Versioning

This project uses [0ver](https://0ver.org/) (zero-based versioning). The major version will remain
at `0` indefinitely. Breaking changes bump the minor version; features and fixes bump the patch
version.

Releases are automated via [release-please](https://github.com/googleapis/release-please). Commits
must follow [Conventional Commits](https://www.conventionalcommits.org/).


## Optional restricted writes (Node HTTP server)

With no `YNAB_WRITE_POLICY` configured, existing toolset and read-only behavior is unchanged. The three restricted tools are hidden until explicitly enabled. For a restricted deployment, configure:

```dotenv
YNAB_WRITE_POLICY=clear-status
YNAB_CLEARED_WRITE_BUDGET=your-budget-id
# Optional category and approval actions, in that same budget:
YNAB_CATEGORY_WRITE_BUDGET=your-budget-id
YNAB_APPROVAL_WRITE_BUDGET=your-budget-id
```

The policy name retains compatibility with the original cleared-status setting. Category and approval tools have separate opt-ins. With this policy enabled, general write tools are hidden and blocked by the dispatcher; only the enabled restricted tools can write, and only in the configured budget. Read-only OAuth grants and `YNAB_READ_ONLY=true` still block every write. Unknown policy names and inconsistent budget settings fail at startup rather than silently changing permissions.

The tool accepts `transaction_id`, optional `budget_id`, and the reviewed `expected_category_id` (null for uncategorized). It reads the current entry and sends only `approved: true`. It cannot unapprove, change clearing status or category, or change financial fields. Deleted/reconciled entries, transfers, splits, changed categories, and extra arguments are rejected. Already approved entries do not issue another write. Approval means accepting the transaction for review purposes; it does not establish bank posting or finalize reconciliation.


### Reconciliation preview and apply

`preview_account_reconciliation` reads an account and its full transaction history with an explicit date floor. Supply the bank's posted balance as signed integer milliunits, excluding pending activity; credit-card debt is negative. The preview checks account/history totals and lists approved, cleared entries to mark reconciled. A balance match does not independently verify posting. No adjustment transactions are created.

To enable `reconcile_account`, set `YNAB_RECONCILIATION_WRITE_BUDGET` to the same budget as `YNAB_CLEARED_WRITE_BUDGET` under the optional restricted policy. Apply only a user-approved preview, supplying its exact account, bank balance, and plan_id. The server re-fetches the snapshot and rejects stale plans or balance mismatches. Uncleared entries and unapproved cleared entries are never automatically accepted or cleared. This version refuses more than 25 eligible entries to bound API usage.

Updates are sequential. The tool preserves approval, marks only cleared entries reconciled, re-reads saved state, and reports partial or uncertain outcomes without automatic retries or reversals. Re-read an incomplete operation before deciding what to do next. The API offers no account-level reconciliation endpoint or setter for last_reconciled_at. The tool reports transaction reconciliation and any observed reconciliation-date change separately; it does not claim equivalence to the web account button. It cannot undo reconciliation.
