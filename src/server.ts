#!/usr/bin/env node
// Self-hosted HTTP entrypoint (ADR-0004): the multi-tenant YNAB OAuth MCP server
// as a plain Node + Express process, for Docker/homelab deployment behind a
// private HTTPS front (Tailscale `serve` or a reverse proxy). All real logic lives
// in the tsgo-checked, unit-tested core modules; this file is the thin bootstrap.

import "dotenv/config";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

import type { OAuthConfig } from "./oauth-config.js";
import type { ToolContext } from "./tools.js";
import type { OAuthProps } from "./worker-config.js";

import { YnabClient } from "./client.js";
import { importKey, seal, unseal } from "./encryption.js";
import { requireEnv } from "./env.js";
import { buildMcpServer } from "./mcp-server.js";
import { YNAB_AUTHORIZE_ENDPOINT, YNAB_TOKEN_ENDPOINT } from "./oauth-config.js";
import { YnabOAuthProvider } from "./oauth-server.js";
import { Store } from "./store.js";
import { parseReadOnly, parseToolsets } from "./toolsets.js";
import { makeToolContextFromProps } from "./worker-config.js";

const ConsentForm = z.object({ pending: z.string(), scope: z.string().optional() });
const CallbackQuery = z.object({ state: z.string().optional(), code: z.string().optional() });

// MCP-client access token lifetime (~1h57m) — under YNAB's 2h so the client
// refreshes before the upstream token dies (which refreshes YNAB underneath).
const ACCESS_TOKEN_TTL_SEC = 7000;

async function main(): Promise<void> {
  const publicUrl = requireEnv(
    process.env["PUBLIC_URL"],
    "PUBLIC_URL",
    "The external https base URL, e.g. https://ynab.your-tailnet.ts.net",
  );
  const encKey = await importKey(
    requireEnv(
      process.env["ENCRYPTION_KEY"],
      "ENCRYPTION_KEY",
      "Generate with: openssl rand -base64 32",
    ),
  );
  const config: OAuthConfig = {
    authorizeEndpoint: YNAB_AUTHORIZE_ENDPOINT,
    tokenEndpoint: YNAB_TOKEN_ENDPOINT,
    clientId: requireEnv(process.env["YNAB_CLIENT_ID"], "YNAB_CLIENT_ID"),
    clientSecret: requireEnv(process.env["YNAB_CLIENT_SECRET"], "YNAB_CLIENT_SECRET"),
    redirectUri: (process.env["YNAB_REDIRECT_URI"] ?? `${publicUrl}/callback`).trim(),
    cookieSecret: "", // unused in the Node flow (state is DB-backed, not cookie-backed)
  };
  const databasePath = (process.env["DATABASE_PATH"] ?? "./data/ynab-mcp.db").trim();
  const port = Number(process.env["PORT"] ?? "8080");
  // Opt-in: accept a YNAB Personal Access Token directly as the /mcp bearer (for
  // headless/simple clients that just send `Authorization: Bearer <PAT>` — no
  // OAuth flow). Off by default; the OAuth path is unaffected either way.
  const allowPat = /^(true|1)$/i.test((process.env["YNAB_PAT_PASSTHROUGH"] ?? "").trim());
  const patReadOnly = parseReadOnly(process.env["YNAB_READ_ONLY"]);
  const clearStatusOnly = process.env["YNAB_WRITE_POLICY"] === "clear-status";
  if (!patReadOnly && !clearStatusOnly) {
    throw new Error(
      "This local deployment requires read-only mode or the clear-status write policy.",
    );
  }
  const clearedWriteBudget = process.env["YNAB_CLEARED_WRITE_BUDGET"]?.trim();
  if (clearStatusOnly && !clearedWriteBudget)
    throw new Error("YNAB_CLEARED_WRITE_BUDGET is required");

  const categoryWriteBudget = process.env["YNAB_CATEGORY_WRITE_BUDGET"]?.trim();
  if (categoryWriteBudget && (!clearStatusOnly || categoryWriteBudget !== clearedWriteBudget))
    throw new Error("Category writes require the restricted policy and the same approved budget.");

  const store = new Store(databasePath);
  const provider = new YnabOAuthProvider({
    store,
    config,
    encKey,
    fetchFn: fetch,
    accessTokenTtlSec: ACCESS_TOKEN_TTL_SEC,
  });

  const app = express();
  // Behind the Tailscale `serve` (or a reverse proxy) on loopback, so trust the
  // X-Forwarded-* headers from 127.0.0.1 — needed for express-rate-limit to read
  // the client IP instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  app.set("trust proxy", "loopback");

  // Lightweight request log (skips /health) — shows requests arriving + their
  // status/duration, so a hanging call is visible as a "→" with no matching "←".
  app.use((req, res, next) => {
    if (req.path === "/health") {
      next();
      return;
    }
    const startedAt = Date.now();
    console.error(`→ ${req.method} ${req.path}`);
    res.on("finish", () => {
      console.error(`← ${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
    next();
  });

  // The MCP endpoint is the OAuth protected resource (RFC 9728). Advertising it as
  // `${PUBLIC_URL}/mcp` makes the SDK serve protected-resource metadata at
  // /.well-known/oauth-protected-resource/mcp, which clients (Claude Desktop, etc.)
  // discover to start the OAuth flow.
  const issuerUrl = new URL(publicUrl);
  const resourceServerUrl = new URL("/mcp", publicUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  // OAuth server endpoints to MCP clients: /authorize, /token, /register, /revoke,
  // and the .well-known metadata. Must be mounted at the application root.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl,
      resourceName: "YNAB MCP",
      scopesSupported: patReadOnly ? ["ynab.read"] : ["ynab.read", "ynab.write"],
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Consent submitted → begin the upstream YNAB login leg.
  app.post("/ynab/consent", express.urlencoded({ extended: false }), (req, res) => {
    const form = ConsentForm.safeParse(req.body);
    if (!form.success) {
      res.status(400).send("Missing pending authorization");
      return;
    }
    provider
      .beginUpstreamLogin(
        form.data.pending,
        patReadOnly ? "read-only" : (form.data.scope ?? "read-only"),
      )
      .then((location) => res.redirect(302, location))
      .catch((err: unknown) => res.status(500).send(errorText(err)));
  });

  // YNAB redirects here → complete the grant and redirect back to the MCP client.
  app.get("/callback", (req, res) => {
    const query = CallbackQuery.safeParse(req.query);
    provider
      .handleCallback({
        state: query.success ? (query.data.state ?? null) : null,
        code: query.success ? (query.data.code ?? null) : null,
      })
      .then((result) => {
        if (result.ok && result.redirectTo) {
          res.redirect(302, result.redirectTo);
        } else {
          res.status(result.status ?? 400).send(result.message ?? "Authorization failed");
        }
      })
      .catch((err: unknown) => res.status(500).send(errorText(err)));
  });

  // OAuth bearer auth (standard path). When PAT pass-through is on, a bearer that
  // isn't one of our OAuth tokens is treated as a YNAB PAT instead of a 401.
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });
  const mcpAuth: express.RequestHandler = !allowPat
    ? bearer
    : (req, res, next) => {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        if (!token) {
          bearer(req, res, next);
          return;
        }
        provider.verifyAccessToken(token).then(
          () => bearer(req, res, next),
          () => {
            req.auth = {
              token,
              clientId: "pat",
              scopes: ["ynab.read", "ynab.write"],
              extra: { pat: token },
            };
            next();
          },
        );
      };

  // The authenticated MCP endpoint (stateless Streamable HTTP, one transport per request).
  app.all("/mcp", mcpAuth, express.json(), (req, res) => {
    handleMcp(
      {
        provider,
        store,
        encKey,
        config,
        patReadOnly,
        clearStatusOnly,
        clearedWriteBudget,
        categoryWriteBudget,
      },
      req,
      res,
    ).catch((err: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: errorText(err) });
    });
  });

  app.listen(port, () => {
    console.error(`YNAB MCP server listening on :${port} (public: ${publicUrl})`);
  });
}

interface McpDeps {
  provider: YnabOAuthProvider;
  store: Store;
  encKey: CryptoKey;
  config: OAuthConfig;
  patReadOnly: boolean;
  clearStatusOnly: boolean;
  clearedWriteBudget: string | undefined;
  categoryWriteBudget: string | undefined;
}

// Resolve the ToolContext for this request: a YNAB PAT passed straight through,
// or the per-tenant OAuth grant (decrypted, refreshed-on-expiry, persisted).
// Returns null and writes a 401 if neither is present.
async function resolveContext(deps: McpDeps, req: express.Request, res: express.Response) {
  const pat = req.auth?.extra?.["pat"];
  if (typeof pat === "string") {
    const ctx: ToolContext = {
      client: new YnabClient(pat),
      enabledGroups: parseToolsets("all"),
      readOnly: deps.patReadOnly,
      defaultBudget: "last-used",
      ...(deps.clearStatusOnly
        ? {
            writePolicy: "clear-status" as const,
            clearedWriteBudget: deps.clearedWriteBudget,
            categoryWriteBudget: deps.categoryWriteBudget,
          }
        : {}),
    };
    return { ctx, note: "pat" };
  }

  const grantId = req.auth?.extra?.["grantId"];
  if (typeof grantId !== "string") {
    res.status(401).json({ error: "No grant associated with token" });
    return null;
  }
  const grant = deps.store.getGrant(grantId);
  if (!grant) {
    res.status(401).json({ error: "Grant no longer exists" });
    return null;
  }
  const props: OAuthProps = {
    accessToken: await unseal(deps.encKey, grant.encAccess),
    refreshToken: await unseal(deps.encKey, grant.encRefresh),
    expiresAt: grant.expiresAt,
    readOnly: grant.readOnly,
  };
  const { ctx, refreshed } = await makeToolContextFromProps(props, deps.config, fetch, Date.now());
  ctx.readOnly = ctx.readOnly || deps.patReadOnly;
  if (deps.clearStatusOnly) {
    ctx.writePolicy = "clear-status";
    ctx.clearedWriteBudget = deps.clearedWriteBudget;
    ctx.categoryWriteBudget = deps.categoryWriteBudget;
  }
  if (refreshed) {
    deps.store.updateGrantTokens(
      grantId,
      await seal(deps.encKey, refreshed.accessToken),
      await seal(deps.encKey, refreshed.refreshToken),
      refreshed.expiresAt,
    );
  }
  return { ctx, note: refreshed ? "grant(refreshed)" : "grant" };
}

async function handleMcp(
  deps: McpDeps,
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const resolved = await resolveContext(deps, req, res);
  if (!resolved) return;

  // enableJsonResponse: reply with a single JSON body instead of an SSE stream —
  // SSE gets buffered by reverse proxies (e.g. Tailscale `serve`), which makes
  // tool calls hang until the client times out.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  console.error(`[mcp] context ready (${resolved.note}) → transport`);
  const server = buildMcpServer(resolved.ctx);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
