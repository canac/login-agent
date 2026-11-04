import assert from "node:assert/strict";
import { test } from "node:test";
import { Secret } from "otpauth";
import { generateTotp, parseTotp } from "../../src/totp.ts";

// RFC 6238 appendix B: the seeds are these ASCII strings, 8 digits, 30 s period.
const seeds = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
};
const vectors: [number, Record<keyof typeof seeds, string>][] = [
  [59, { SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" }],
  [1111111109, { SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" }],
  [1111111111, { SHA1: "14050471", SHA256: "67062674", SHA512: "99943326" }],
  [1234567890, { SHA1: "89005924", SHA256: "91819424", SHA512: "93441116" }],
  [2000000000, { SHA1: "69279037", SHA256: "90698825", SHA512: "38618901" }],
  [20000000000, { SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" }],
];

for (const [algorithm, ascii] of Object.entries(seeds) as [keyof typeof seeds, string][]) {
  test(`RFC 6238 vectors, ${algorithm}`, () => {
    const base32 = Secret.fromUTF8(ascii).base32;
    const url = `otpauth://totp/test?secret=${base32}&algorithm=${algorithm}&digits=8&period=30`;
    for (const [seconds, expected] of vectors) {
      assert.equal(generateTotp(url, seconds * 1000), expected[algorithm], `t=${seconds}`);
    }
  });
}

test("bare base32 seed defaults to SHA1, 6 digits", () => {
  const base32 = Secret.fromUTF8(seeds.SHA1).base32;
  assert.equal(generateTotp(base32, 59_000), "287082");
  assert.equal(generateTotp(base32.toLowerCase().replace(/(.{4})/g, "$1 "), 59_000), "287082");
});

test("rejects HOTP URLs and non-base32 seeds", () => {
  assert.throws(() => parseTotp("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1"), /TOTP/);
  assert.throws(() => parseTotp("hello world!"), /base32/);
});
