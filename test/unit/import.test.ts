import assert from "node:assert/strict";
import { test } from "node:test";
import { aliasFromName, describeLogin, originsFromUris } from "../../src/import.ts";

test("origins come from https URIs, with a scheme added when missing", () => {
  assert.deepEqual(
    originsFromUris([
      { uri: "https://sso.example.com/app/x?y=1" },
      { uri: "github.com/login" },
      { uri: "https://sso.example.com/other" },
      { uri: "http://example.com" },
      { uri: "http://localhost:4100/login" },
      { uri: "androidapp://com.example" },
      { uri: null },
    ]),
    ["https://sso.example.com", "https://github.com", "http://localhost:4100"],
  );
  assert.deepEqual(originsFromUris(null), []);
});

test("a login is described by its origins and username", () => {
  const uris = [{ uri: "https://a.example.com/x" }, { uri: "b.example.com" }];
  assert.equal(describeLogin({ username: "me", uris }), "https://a.example.com, https://b.example.com (me)");
  assert.equal(describeLogin({ username: null, uris }), "https://a.example.com, https://b.example.com");
  assert.equal(describeLogin({ username: "me", uris: [] }), "(no https URL) (me)");
});

test("aliases are slugs of the item name", () => {
  assert.equal(aliasFromName("Example SSO"), "example-sso");
  assert.equal(aliasFromName("  GitHub (work)! "), "github-work");
  assert.equal(aliasFromName("!!!"), "login");
  assert.equal(aliasFromName("a".repeat(80)).length, 64);
});
