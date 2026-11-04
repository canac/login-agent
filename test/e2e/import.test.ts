import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { loadLogins } from "../../src/store.ts";
import { cli } from "./cli.ts";

const FAKE_BW = join(import.meta.dirname!, "../fixtures/bw-bin");

const SSO = {
  id: "11111111-aaaa-4bbb-8ccc-000000000001",
  name: "Example SSO",
  type: 1,
  login: {
    username: "import-user@example.com",
    password: " IMPORT-SENTINEL-PW-1 ",
    totp: "JBSWY3DPEHPK3PXP",
    uris: [{ uri: "https://sso.example.com/app/UserHome" }],
  },
};
const GITHUB = {
  id: "11111111-aaaa-4bbb-8ccc-000000000002",
  name: "GitHub",
  type: 1,
  login: { username: "gh-user", password: "IMPORT-SENTINEL-PW-2", totp: null, uris: [{ uri: "github.com" }] },
};
const NO_URL = {
  id: "11111111-aaaa-4bbb-8ccc-000000000003",
  name: "No URL",
  type: 1,
  login: { password: "IMPORT-SENTINEL-PW-3" },
};
const STEAM = {
  id: "11111111-aaaa-4bbb-8ccc-000000000004",
  name: "Steam",
  type: 1,
  login: { password: "x", totp: "steam://ABCDEF", uris: [{ uri: "https://store.steampowered.com" }] },
};
const NOTE = { id: "11111111-aaaa-4bbb-8ccc-000000000005", name: "Note", type: 2 };
const GITHUB_ENTERPRISE = { ...GITHUB, id: "11111111-aaaa-4bbb-8ccc-000000000006", name: "GitHub Enterprise" };
const SHOWN = [SSO.login.username, GITHUB.login.username];
const SECRETS = [SSO.login.password.trim(), SSO.login.totp, GITHUB.login.password];

let dir: string;
let storeDir: string;
let env: NodeJS.ProcessEnv;

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(cli.command, cli.args(...args), { env: { ...env, ...extra }, encoding: "utf8" });
}

function bwCalls(): string[][] {
  return readFileSync(join(dir, "bw-argv.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const encrypted = () => readFileSync(join(storeDir, "logins.age"));

before(() => {
  dir = mkdtempSync(join(tmpdir(), "login-agent-import-"));
  storeDir = join(dir, "store");
  writeFileSync(join(dir, "items.json"), JSON.stringify([SSO, GITHUB, NO_URL, STEAM, NOTE, GITHUB_ENTERPRISE]));
  env = {
    ...process.env,
    PATH: `${FAKE_BW}${delimiter}${process.env.PATH}`,
    LOGIN_AGENT_CONFIG_DIR: storeDir,
    BW_SESSION: "fake-session",
    FAKE_BW_STORE: join(dir, "items.json"),
    FAKE_BW_LOG: join(dir, "bw-argv.log"),
  };
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("import with no item lists one line per login, with usernames but no secrets", () => {
  const result = run(["bw-import"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      `${SSO.id}  https://sso.example.com (import-user@example.com)`,
      `${GITHUB.id}  https://github.com (gh-user)`,
      `${NO_URL.id}  (no https URL)`,
      `${STEAM.id}  https://store.steampowered.com`,
      `${GITHUB_ENTERPRISE.id}  https://github.com (gh-user)`,
      "",
    ].join("\n"),
  );
  for (const secret of SECRETS) assert.ok(!result.stdout.includes(secret), `leaked ${secret.slice(0, 4)}...`);
});

test("imports an item by id, values exactly as stored", async () => {
  const start = bwCalls().length;
  const sso = run(["bw-import", SSO.id]);
  assert.equal(sso.status, 0, sso.stderr);
  assert.match(sso.stdout, /^example-sso: username, password, TOTP → https:\/\/sso\.example\.com$/m);
  const github = run(["bw-import", GITHUB.id]);
  assert.equal(github.status, 0, github.stderr);
  assert.match(github.stdout, /^github: username, password → https:\/\/github\.com$/m);

  assert.deepEqual(await loadLogins(storeDir), {
    "example-sso": {
      origins: ["https://sso.example.com"],
      username: SSO.login.username,
      password: SSO.login.password,
      totp: SSO.login.totp,
    },
    github: { origins: ["https://github.com"], username: GITHUB.login.username, password: GITHUB.login.password },
  });

  assert.deepEqual(bwCalls().slice(start), [["sync"], ["get", "item", SSO.id], ["sync"], ["get", "item", GITHUB.id]]);
  const leakable = [sso.stdout, sso.stderr, github.stdout, github.stderr, encrypted().toString("latin1")].join("\n");
  for (const secret of [...SHOWN, ...SECRETS]) assert.ok(!leakable.includes(secret), `leaked ${secret.slice(0, 4)}...`);
});

test("list shows aliases and origins only", () => {
  const result = run(["list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "example-sso: https://sso.example.com (TOTP)\ngithub: https://github.com\n");
});

test("re-importing replaces the login", async () => {
  const items = JSON.parse(readFileSync(join(dir, "items.json"), "utf8"));
  items[1].login.password = "IMPORT-SENTINEL-PW-2-NEW";
  writeFileSync(join(dir, "items.json"), JSON.stringify(items));
  assert.equal(run(["bw-import", GITHUB.id]).status, 0);
  const logins = await loadLogins(storeDir);
  assert.equal(logins.github!.password, "IMPORT-SENTINEL-PW-2-NEW");
  assert.ok(logins["example-sso"], "other logins are kept");
});

test("an item with no https URL needs --origin", () => {
  const result = run(["bw-import", NO_URL.id]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"No URL" has no https URL; pass --origin/);
});

test("--alias and --origin replace the defaults", async () => {
  const result = run([
    "bw-import",
    NO_URL.id,
    "--alias",
    "nourl",
    "--origin",
    "https://nourl.example.com",
    "--origin",
    "http://localhost:4100",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await loadLogins(storeDir)).nourl, {
    origins: ["https://nourl.example.com", "http://localhost:4100"],
    password: NO_URL.login.password,
  });
});

test("a bad --origin is refused before anything is written", () => {
  const before = encrypted();
  const result = run(["bw-import", GITHUB.id, "--origin", "github.com"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /github\.origins\.0: must be an origin like https:\/\/example\.com/);
  assert.deepEqual(encrypted(), before);
});

test("an unusable authenticator key is refused before anything is written", () => {
  const before = encrypted();
  const result = run(["bw-import", STEAM.id]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"Steam" has an authenticator key login-agent can't use/);
  assert.deepEqual(encrypted(), before);
});

test("a name instead of an id is refused before bw runs", () => {
  const start = bwCalls().length;
  const result = run(["bw-import", "GitHub"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"GitHub" is not an item id; run bw-import alone to list them/);
  assert.equal(bwCalls().length, start);
});

test("a non-login item is refused", () => {
  const result = run(["bw-import", NOTE.id]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${NOTE.id} is not a login item`));
});

test("an unknown id is an error", () => {
  const result = run(["bw-import", "11111111-aaaa-4bbb-8ccc-0000000000ff"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bw get failed: Not found\./);
});

test("--alias or --origin without an item is an error", () => {
  const result = run(["bw-import", "--alias", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--alias and --origin need an item to import/);
});

test("no BW_SESSION and no terminal is an error before bw runs", () => {
  const start = bwCalls().length;
  const result = run(["bw-import", SSO.id], { BW_SESSION: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set BW_SESSION or run this in a terminal/);
  assert.equal(bwCalls().length, start);
});
