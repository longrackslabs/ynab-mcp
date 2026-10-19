// docs.test.ts — the public docs site (site/) may not claim a surface this repo doesn't have.
//
// Scope, per keel's claims rule (docs/adr/0005): every factual claim on the site must be
// falsifiable against this repo. This test pins the load-bearing ones — the tool/toolset
// counts, and the Trust page's specific claims about encryption, defaults, and limits — plus
// a structural check that no environment variable name appears in the docs unless it's one
// this repo's own server code or deploy config actually reads. It does not (and can't) check
// prose quality; it only catches drift between what the site says and what the code does.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TOOLS } from "../src/tools.js";
import { ALL_GROUPS } from "../src/toolsets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = join(root, "site");
const docsDir = join(siteRoot, "src", "content", "docs");

function readAllDocs(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md"))
        out.push({ file: path, text: readFileSync(path, "utf8") });
    }
  }
  walk(docsDir);
  return out;
}

const trustPage = readFileSync(join(docsDir, "trust", "index.md"), "utf8");
const landingPage = readFileSync(join(siteRoot, "src", "pages", "index.astro"), "utf8");
const llmsTxt = readFileSync(join(siteRoot, "public", "llms.txt"), "utf8");

describe("tool and toolset counts", () => {
  it("the site's claimed tool count (46) matches TOOLS", () => {
    // The private deployment adds restricted tools; the upstream site's count
    // still describes the original upstream tool inventory.
    expect(
      TOOLS.filter(
        (tool) =>
          !["set_transaction_cleared", "set_transaction_category", "approve_transaction"].includes(
            tool.name,
          ),
      ).length,
    ).toBe(46);
    expect(landingPage.includes("46 tools")).toBe(true);
    expect(llmsTxt.includes("46 tools")).toBe(true);
  });

  it("the site's claimed toolset/group count (8) matches ALL_GROUPS", () => {
    expect(ALL_GROUPS.length).toBe(8);
    expect(landingPage.includes("8 toolsets")).toBe(true);
  });

  it("every ToolGroup has a reference page", () => {
    const referenceDir = join(docsDir, "reference");
    const pages = new Set(readdirSync(referenceDir).map((f) => f.replace(/\.md$/, "")));
    for (const group of ALL_GROUPS) {
      expect(pages.has(group), `reference/${group}.md is missing`).toBe(true);
    }
  });
});

describe("Trust page — load-bearing claims", () => {
  it("states upstream YNAB tokens are encrypted at rest with AES-256-GCM", () => {
    expect(trustPage).toMatch(/AES-256-GCM/);
    // ...and the code actually does this (src/encryption.ts uses the AES-GCM algorithm).
    const encryption = readFileSync(join(root, "src", "encryption.ts"), "utf8");
    expect(encryption).toMatch(/AES-GCM/);
  });

  it("states issued tokens are stored as hashes, never in the clear", () => {
    expect(trustPage).toMatch(/SHA-256/);
    expect(trustPage.toLowerCase()).toMatch(/hash/);
    const store = readFileSync(join(root, "src", "store.ts"), "utf8");
    expect(store).toMatch(/token_hash/);
  });

  it("states the server is read-only by default", () => {
    expect(trustPage.toLowerCase()).toMatch(/read-only/);
    // ...and the code actually defaults to it (both env-var parsing and the OAuth consent form).
    const toolsets = readFileSync(join(root, "src", "toolsets.ts"), "utf8");
    expect(toolsets).toMatch(/parseReadOnly/);
    const oauthServer = readFileSync(join(root, "src", "oauth-server.ts"), "utf8");
    expect(oauthServer).toMatch(/Read-only \(recommended\)/);
  });

  it("states bank linking is impossible via the YNAB API", () => {
    expect(trustPage.toLowerCase()).toMatch(/cannot link a bank account/);
    // ...and the code's own tool descriptions make the same claim (src/tools.ts).
    const createAccount = TOOLS.find((t) => t.name === "create_account");
    expect(createAccount?.description).toMatch(/cannot link a bank/i);
    const importTxns = TOOLS.find((t) => t.name === "import_transactions");
    expect(importTxns?.description).toMatch(/[Cc]annot create the link/);
  });

  it("states the YNAB API's 200 requests/hour rate limit", () => {
    expect(trustPage).toMatch(/200 requests per hour|200 req/i);
  });

  it("is not affiliated with YNAB", () => {
    expect(trustPage.toLowerCase()).toMatch(/not affiliated with ynab/);
  });
});

describe("environment variable names match the real code", () => {
  // The allowlist: every ALL_CAPS_WITH_UNDERSCORE token that appears in the places that
  // actually define config surface — the stdio/server env reads and the deploy config —
  // so a doc can't invent a flag that isn't backed by any of them.
  function tokensIn(text: string): Set<string> {
    return new Set(text.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []);
  }

  const codeSurface = [
    readFileSync(join(root, "src", "index.ts"), "utf8"),
    readFileSync(join(root, "src", "stdio-config.ts"), "utf8"),
    readFileSync(join(root, "src", "server.ts"), "utf8"),
    readFileSync(join(root, "docker-compose.yml"), "utf8"),
    readFileSync(join(root, "docs", "DEPLOY.md"), "utf8"),
  ].join("\n");
  const allowlist = tokensIn(codeSurface);

  it("found a non-trivial allowlist (sanity check the scan itself works)", () => {
    expect(allowlist.has("YNAB_TOKEN")).toBe(true);
    expect(allowlist.has("YNAB_READ_ONLY")).toBe(true);
    expect(allowlist.has("ENCRYPTION_KEY")).toBe(true);
  });

  it("every env-var-shaped token in the docs site is one the code/deploy config actually defines", () => {
    for (const { file, text } of readAllDocs()) {
      for (const token of tokensIn(text)) {
        expect(
          allowlist.has(token),
          `${file.slice(root.length + 1)} mentions \`${token}\`, which doesn't appear in ` +
            "src/index.ts, src/stdio-config.ts, src/server.ts, docker-compose.yml, or docs/DEPLOY.md",
        ).toBe(true);
      }
    }
  });
});
