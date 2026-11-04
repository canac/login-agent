import { spawn } from "node:child_process";
import { isLoginOrigin, loadLogins, type Logins, saveLogins } from "./store.ts";
import { parseTotp } from "./totp.ts";

interface BwItem {
  id: string;
  name: string;
  type: number;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null }[] | null;
  };
}

export interface ImportOptions {
  /** The Bitwarden item id. */
  item: string;
  /** Defaults to a slug of the item's name. */
  alias?: string;
  /** Defaults to the https origins of the item's URIs. */
  origins?: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The login origins an item's URIs point at: https, or http on localhost. */
export function originsFromUris(uris: { uri?: string | null }[] | null | undefined): string[] {
  const origins = new Set<string>();
  for (const { uri } of uris ?? []) {
    if (!uri) continue;
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`);
    } catch {
      continue;
    }
    if (isLoginOrigin(url)) origins.add(url.origin);
  }
  return [...origins];
}

export function aliasFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return slug || "login";
}

/** A login's origins, then its username so logins on the same site can be told apart. */
export function describeLogin(login: BwItem["login"]): string {
  const origins = originsFromUris(login?.uris).join(", ") || "(no https URL)";
  return login?.username ? `${origins} (${login.username})` : origins;
}

/** Runs `bw` with the session in its environment. stdout may hold vault secrets, so it is never put in an error. */
function bw(args: string[], session: string | undefined, stdin: "ignore" | "inherit" = "ignore"): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = session ? { ...process.env, BW_SESSION: session } : process.env;
    const child = spawn("bw", args, { env, stdio: [stdin, "pipe", stdin === "inherit" ? "inherit" : "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d));
    child.stderr?.on("data", (d: Buffer) => (stderr += d));
    child.on("error", (error) => reject(new Error(`could not run bw: ${error.message}`)));
    child.on(
      "close",
      (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`bw ${args[0]} failed: ${stderr.trim().split("\n")[0] || `exit ${code}`}`)),
    );
  });
}

/** A session token for bw, syncing the vault so a login just changed in Bitwarden is seen. */
async function syncedSession(): Promise<string> {
  let token = process.env.BW_SESSION;
  if (!token) {
    if (!process.stdin.isTTY) throw new Error("Set BW_SESSION or run this in a terminal so bw can unlock the vault.");
    // Prompts for the master password on the terminal; only the session token comes back on stdout.
    token = (await bw(["unlock", "--raw"], undefined, "inherit")).trim();
  }
  await bw(["sync"], token);
  return token;
}

const isLogin = (item: BwItem) => item.type === 1 && Boolean(item.login);

/**
 * Runs fzf over the lines, each `<id>\t<shown text>`.
 * Resolves to the picked id, null when the pick was cancelled, or undefined when fzf isn't installed.
 */
function pickWithFzf(lines: string[]): Promise<string | null | undefined> {
  return new Promise((resolve, reject) => {
    const { BW_SESSION: _, ...env } = process.env;
    const child = spawn("fzf", ["--delimiter=\t", "--with-nth=2..", "--prompt=import> "], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d));
    child.stdin!.on("error", () => {}); // EPIPE when fzf is missing or exits early
    child.on(
      "error",
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? resolve(undefined) : reject(new Error(`could not run fzf: ${error.message}`)),
    );
    child.on("close", (code) => resolve(code === 0 ? stdout.split("\t")[0]! : null));
    child.stdin!.end(lines.join("\n") + "\n");
  });
}

/** Prints each login item on its own line, or in a terminal with fzf installed, imports the one picked. */
export async function pickBitwardenLogin(): Promise<void> {
  const logins = await loadLogins();
  const token = await syncedSession();
  const items = (JSON.parse(await bw(["list", "items"], token)) as BwItem[]).filter(isLogin);
  if (!items.length) throw new Error("No login items found in Bitwarden");
  const lines = items.map((item) => `${item.id}\t${describeLogin(item.login)}`);
  if (process.stdout.isTTY) {
    const id = await pickWithFzf(lines);
    if (id === null) return;
    if (id !== undefined) {
      const item = items.find((item) => item.id === id);
      if (!item) throw new Error(`fzf picked an unknown item: ${id}`);
      return importItem(logins, item, {});
    }
  }
  for (const line of lines) console.log(line.replace("\t", "  "));
}

/** Copies one Bitwarden login into the store, replacing whatever the alias held. */
export async function importLogin(options: ImportOptions): Promise<void> {
  if (!UUID_PATTERN.test(options.item)) {
    throw new Error(`"${options.item}" is not an item id; run bw-import alone to list them`);
  }
  const logins = await loadLogins();
  const item = JSON.parse(await bw(["get", "item", options.item], await syncedSession())) as BwItem;
  if (!isLogin(item)) throw new Error(`${options.item} is not a login item`);
  await importItem(logins, item, options);
}

async function importItem(logins: Logins, item: BwItem, options: Omit<ImportOptions, "item">): Promise<void> {
  const alias = options.alias ?? aliasFromName(item.name);
  const origins = options.origins?.length ? options.origins : originsFromUris(item.login?.uris);
  if (!origins.length) throw new Error(`"${item.name}" has no https URL; pass --origin https://...`);
  const { username, password, totp } = item.login ?? {};
  if (totp) {
    try {
      parseTotp(totp);
    } catch {
      throw new Error(`"${item.name}" has an authenticator key login-agent can't use (only base32 or otpauth://totp)`);
    }
  }
  const login = { origins, username: username || undefined, password: password || undefined, totp: totp || undefined };
  await saveLogins({ ...logins, [alias]: login });
  const what = [username && "username", password && "password", totp && "TOTP"].filter(Boolean);
  console.log(`${alias}: ${what.join(", ")} → ${origins.join(", ")}`);
  console.log("\nAgents pick up the change on their next call.");
}
