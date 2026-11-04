import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseTotp } from "./totp.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for https, or http on localhost: the only schemes a login may be filled on. */
export function isLoginOrigin(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}

export const Origin = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be an origin like https://example.com" });
    return;
  }
  if (url.origin !== value) {
    ctx.addIssue({ code: "custom", message: `must be exactly an origin (scheme://host[:port]), e.g. ${url.origin}` });
  } else if (!isLoginOrigin(url)) {
    ctx.addIssue({ code: "custom", message: "must use https (http is only allowed for localhost)" });
  }
});

const LoginSchema = z.strictObject({
  origins: z.array(Origin).min(1, "needs at least one origin"),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  totp: z
    .string()
    .refine(
      (value) => {
        try {
          parseTotp(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be a base32 seed or an otpauth://totp URL" },
    )
    .optional(),
});

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const LoginsSchema = z.record(z.string(), LoginSchema).superRefine((logins, ctx) => {
  for (const alias of Object.keys(logins)) {
    if (!ALIAS_PATTERN.test(alias)) {
      ctx.addIssue({
        code: "custom",
        path: [alias],
        message: "alias must be lowercase letters, digits, - or _, up to 64 chars",
      });
    }
  }
});

export type Login = z.infer<typeof LoginSchema>;
export type Logins = Record<string, Login>;

export function storeDir(): string {
  return process.env.LOGIN_AGENT_CONFIG_DIR || join(homedir(), ".config", "login-agent");
}

const keyPath = (dir: string) => join(dir, "key.txt");
const loginsPath = (dir: string) => join(dir, "logins.age");

/** Validates logins. Error messages name paths, never values. */
export function validateLogins(raw: unknown): Logins {
  const parsed = LoginsSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Invalid logins:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Decrypts the logins file. No file yet means no logins. */
export async function loadLogins(dir = storeDir()): Promise<Logins> {
  if (!existsSync(loginsPath(dir))) return {};
  if (!existsSync(keyPath(dir))) throw new Error(`${loginsPath(dir)} exists but ${keyPath(dir)} is missing`);
  const decrypter = new Decrypter();
  decrypter.addIdentity(readFileSync(keyPath(dir), "utf8").trim());
  let text: string;
  try {
    text = await decrypter.decrypt(readFileSync(loginsPath(dir)), "text");
  } catch {
    throw new Error(`Could not decrypt ${loginsPath(dir)} with ${keyPath(dir)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // SyntaxError messages quote the plaintext, which holds the secrets.
    throw new Error(`${loginsPath(dir)} does not hold valid JSON`);
  }
  return validateLogins(raw);
}

/** Encrypts and writes the logins, creating the directory and key on first use. */
export async function saveLogins(logins: Logins, dir = storeDir()): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(keyPath(dir))) {
    writeFileSync(keyPath(dir), `${await generateX25519Identity()}\n`, { mode: 0o600, flag: "wx" });
  }
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(readFileSync(keyPath(dir), "utf8").trim()));
  const ciphertext = await encrypter.encrypt(JSON.stringify(validateLogins(logins)));
  // Through a temp file and rename so a crash never leaves a half-written file.
  const tmp = `${loginsPath(dir)}.tmp-${process.pid}`;
  writeFileSync(tmp, ciphertext, { mode: 0o600 });
  renameSync(tmp, loginsPath(dir));
}
