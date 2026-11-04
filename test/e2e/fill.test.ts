// The SDK's wildcard export maps types to *.js.d.ts, which don't exist, so point Deno at the real ones.
// @ts-types="@modelcontextprotocol/sdk/client/index"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// @ts-types="@modelcontextprotocol/sdk/client/stdio"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Secret } from "otpauth";
import { type Browser, chromium, type Page } from "playwright-core";
import { Filler } from "../../src/fill.ts";
import { type Logins, saveLogins } from "../../src/store.ts";
import { generateTotp } from "../../src/totp.ts";
import { cli } from "./cli.ts";
import { type Site, startSite } from "./site.ts";

const CHROME = process.env.CHROME ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
  ].find(
    existsSync,
  );

const USERNAME = `sentinel-user-${randomBytes(4).toString("hex")}@example.com`;
const PASSWORD = `SENTINEL-PW-${randomBytes(8).toString("hex")}`;
const NEW_PASSWORD = `SENTINEL-PW2-${randomBytes(8).toString("hex")}`;
const SEED = new Secret({ size: 20 }).base32;

let site: Site;
let chrome: ChildProcess;
let agentBrowser: Browser;
let client: Client;
let cdpUrl: string;
let dir: string;
let storeDir: string;
let mcpLog = "";
const responses: string[] = [];

async function waitFor<T>(what: string, fn: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function fill(alias: string): Promise<string> {
  const result = await client.callTool({ name: "fill", arguments: { alias } });
  const text = (result.content as { text: string }[]).map((c) => c.text).join("\n");
  responses.push(text);
  return text;
}

/** Leaves exactly one tab open, on `url`, the way the agent's own browser tool would. */
async function openOnly(url: string): Promise<Page> {
  const context = agentBrowser.contexts()[0]!;
  const [first, ...rest] = context.pages();
  for (const page of rest) await page.close();
  const page = first ?? (await context.newPage());
  await page.goto(url);
  return page;
}

function store(password: string): Promise<void> {
  const logins: Logins = {
    site: { origins: [site.right], username: USERNAME, password, totp: SEED },
    nototp: { origins: [site.right], username: USERNAME, password },
  };
  return saveLogins(logins, storeDir);
}

const since = (count: number) => site.submissions.slice(count);

before(async () => {
  assert.ok(CHROME, "Set CHROME to a Chrome or Chromium binary");
  site = await startSite();
  dir = mkdtempSync(join(tmpdir(), "login-agent-e2e-"));
  storeDir = join(dir, "store");
  await store(PASSWORD);

  const profile = join(dir, "profile");
  chrome = spawn(
    CHROME!,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeLog = "";
  chrome.stderr!.on("data", (d) => (chromeLog += d));
  const port = await waitFor("Chrome DevToolsActivePort", () => {
    const file = join(profile, "DevToolsActivePort");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n")[0] : undefined;
  }).catch((error) => {
    throw new Error(`${error.message} (Chrome exit code ${chrome.exitCode}):\n${chromeLog}`);
  });
  cdpUrl = `http://127.0.0.1:${port}`;
  agentBrowser = await chromium.connectOverCDP(cdpUrl);

  const transport = new StdioClientTransport({
    command: cli.command,
    args: cli.args("mcp", "--cdp-endpoint", cdpUrl),
    env: { ...(process.env as Record<string, string>), LOGIN_AGENT_CONFIG_DIR: storeDir },
    stderr: "pipe",
  });
  transport.stderr!.on("data", (d) => (mcpLog += d));
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
  await agentBrowser?.close().catch(() => {});
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
  }
  await site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("list_logins shows no credentials", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["fill", "list_logins"]);
  const result = await client.callTool({ name: "list_logins", arguments: {} });
  const text = (result.content as { text: string }[])[0]!.text;
  responses.push(text);
  assert.deepEqual(JSON.parse(text), {
    site: { origins: [site.right], hasTotp: true },
    nototp: { origins: [site.right], hasTotp: false },
  });
});

test("one-page login", async () => {
  const before = site.submissions.length;
  const page = await openOnly(`${site.right}/login`);
  assert.match(await fill("site"), /^Password filled and submitted/);
  assert.deepEqual(since(before), [{
    site: "right",
    path: "/login",
    form: { username: USERNAME, password: PASSWORD },
  }]);
  assert.equal(await page.title(), "Signed in");
});

test("two-step login takes one fill per page", async () => {
  const before = site.submissions.length;
  await openOnly(`${site.right}/two-step`);
  assert.match(await fill("site"), /^Username filled and submitted/);
  assert.match(await fill("site"), /^Password filled and submitted/);
  assert.deepEqual(since(before), [
    { site: "right", path: "/two-step/email", form: { email: USERNAME } },
    { site: "right", path: "/two-step/password", form: { email: USERNAME, password: PASSWORD, login: "Sign in" } },
  ]);
});

test("TOTP page gets a current code", async () => {
  const before = site.submissions.length;
  await openOnly(`${site.right}/otp`);
  const now = Date.now();
  assert.match(await fill("site"), /^Verification code filled and submitted/);
  const valid = [now - 30_000, now, now + 30_000].map((t) => generateTotp(SEED, t));
  assert.ok(valid.includes(since(before)[0]!.form.otp!), "submitted a current TOTP code");
});

test("a TOTP page for a login without a seed is refused", async () => {
  await openOnly(`${site.right}/otp`);
  assert.equal(await fill("nototp"), '"nototp" has no TOTP seed stored. Import it again from Bitwarden.');
});

test("a new import applies on the next call with no restart", async () => {
  await store(NEW_PASSWORD);
  try {
    const before = site.submissions.length;
    await openOnly(`${site.right}/login`);
    assert.match(await fill("site"), /^Password filled and submitted/);
    assert.equal(since(before)[0]!.form.password, NEW_PASSWORD);
  } finally {
    await store(PASSWORD);
  }
});

test("form still showing after submit is reported and cleared", async () => {
  const page = await openOnly(`${site.right}/stuck`);
  assert.match(await fill("site"), /^Submitted, but the form is still showing/);
  assert.equal(await page.locator('input[type="password"]').inputValue(), "");
});

test("wrong origin is refused and nothing is sent", async () => {
  const before = site.submissions.length;
  await openOnly(`${site.wrong}/login`);
  assert.match(await fill("site"), /^No open tab is on an allowed origin/);
  assert.deepEqual(since(before), []);
});

test("a redirect to another origin between steps is never filled", async () => {
  const before = site.submissions.length;
  await openOnly(`${site.right}/hijack`);
  assert.match(await fill("site"), /^Username filled and submitted/);
  assert.match(await fill("site"), /^No open tab is on an allowed origin/);
  assert.deepEqual(since(before), [{ site: "right", path: "/hijack/email", form: { email: USERNAME } }]);
});

test("a page that leaves for another origin mid-fill never sends it the password", async () => {
  const before = site.submissions.length;
  await openOnly(`${site.right}/bait`);
  assert.doesNotMatch(await fill("site"), /filled and submitted/);
  assert.ok(!since(before).some((s) => s.site === "wrong"), "the other origin received nothing");
});

test("more than one tab on the origin is refused", async () => {
  await openOnly(`${site.right}/login`);
  const second = await agentBrowser.contexts()[0]!.newPage();
  await second.goto(`${site.right}/login`);
  assert.match(await fill("site"), /^More than one visible tab/);
  await second.close();
});

test("unknown alias", async () => {
  assert.equal(await fill("nope"), 'Unknown login "nope". Call list_logins to see what is available.');
});

test("a frozen page times out the fill and frees the queue", async () => {
  const page = await openOnly(`${site.right}/frozen`);
  const filler = new Filler({ cdpUrl, log: () => {}, fillTimeoutMs: 2000 });
  const login = { origins: [site.right], username: USERNAME, password: PASSWORD };
  const started = Date.now();
  assert.match(await filler.fill("site", login), /^The fill took too long/);
  assert.ok(Date.now() - started < 10_000, "the fill returned soon after its deadline");
  await page.close();
  const other = { ...login, origins: [site.wrong] };
  assert.match(await filler.fill("other", other), /^No open tab/);
});

test("no secret appears in any MCP response or server log line", () => {
  const codes = [-60_000, -30_000, 0, 30_000].map((offset) => generateTotp(SEED, Date.now() + offset));
  const haystack = [...responses, mcpLog].join("\n");
  for (const secret of [USERNAME, PASSWORD, NEW_PASSWORD, SEED, ...codes]) {
    assert.ok(!haystack.includes(secret), `leaked ${secret.slice(0, 6)}...`);
  }
  assert.match(mcpLog, /fill site:/, "the server logged the fills");
});
