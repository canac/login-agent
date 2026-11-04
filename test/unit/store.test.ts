import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Encrypter, identityToRecipient } from "age-encryption";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadLogins, saveLogins, validateLogins } from "../../src/store.ts";

const root = mkdtempSync(join(tmpdir(), "login-agent-store-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => join(root, `store-${n++}`);

const LOGINS = {
  sso: {
    origins: ["https://sso.example.com"],
    username: "me@example.com",
    password: "SENTINEL-store-pw",
    totp: "JBSWY3DPEHPK3PXP",
  },
  local: { origins: ["http://localhost:4100"], password: " spaces kept " },
};

test("round trip creates a private dir, key, and ciphertext", async () => {
  const dir = freshDir();
  await saveLogins(LOGINS, dir);
  assert.deepEqual(await loadLogins(dir), LOGINS);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "key.txt")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "logins.age")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(dir, "logins.age"), "latin1").includes("SENTINEL"));
});

test("saving again keeps the same key", async () => {
  const dir = freshDir();
  await saveLogins(LOGINS, dir);
  const key = readFileSync(join(dir, "key.txt"), "utf8");
  await saveLogins({}, dir);
  assert.equal(readFileSync(join(dir, "key.txt"), "utf8"), key);
  assert.deepEqual(await loadLogins(dir), {});
});

test("no file yet means no logins", async () => {
  assert.deepEqual(await loadLogins(freshDir()), {});
});

test("the wrong key gives a clean error", async () => {
  const dir = freshDir();
  const other = freshDir();
  await saveLogins(LOGINS, dir);
  await saveLogins({}, other);
  writeFileSync(join(dir, "key.txt"), readFileSync(join(other, "key.txt")));
  await assert.rejects(loadLogins(dir), /Could not decrypt .*logins\.age with .*key\.txt/);
});

test("a file that is not JSON gives an error without its contents", async () => {
  const dir = freshDir();
  await saveLogins({}, dir);
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(readFileSync(join(dir, "key.txt"), "utf8").trim()));
  writeFileSync(join(dir, "logins.age"), await encrypter.encrypt('{"a": SENTINEL-json'));
  await assert.rejects(
    loadLogins(dir),
    (error: Error) => /not hold valid JSON/.test(error.message) && !error.message.includes("SENTINEL"),
  );
});

test("the age CLI can decrypt the file", async () => {
  const dir = freshDir();
  await saveLogins(LOGINS, dir);
  const result = spawnSync("age", ["-d", "-i", join(dir, "key.txt"), join(dir, "logins.age")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), LOGINS);
});

const rejects = (name: string, value: unknown, pattern: RegExp) =>
  test(`rejects ${name}`, () => assert.throws(() => validateLogins(value), pattern));

rejects("a login with no origins", { a: { origins: [] } }, /a\.origins: needs at least one origin/);
rejects("a non-https origin", { a: { origins: ["http://example.com"] } }, /must use https/);
rejects("an origin with a path", { a: { origins: ["https://example.com/login"] } }, /exactly an origin/);
rejects("an uppercase alias", { SSO: { origins: ["https://a.com"] } }, /alias must be lowercase/);
rejects("an unknown field", { a: { origins: ["https://a.com"], usernameSelector: "#u" } }, /Unrecognized key/);
rejects(
  "a bad TOTP seed",
  { a: { origins: ["https://a.com"], totp: "not a seed!" } },
  /a\.totp: must be a base32 seed/,
);

test("validation errors do not echo values", () => {
  const sentinel = "SENTINEL-validation!";
  for (
    const value of [
      { a: { origins: [sentinel] } },
      { a: { origins: ["https://a.com"], totp: sentinel } },
      { a: { origins: ["https://a.com"], password: [sentinel] } },
    ]
  ) {
    assert.throws(() => validateLogins(value), (error: Error) => !error.message.includes(sentinel));
  }
});
