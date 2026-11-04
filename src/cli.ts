import { parseArgs } from "node:util";
import { importLogin, pickBitwardenLogin } from "./import.ts";
import { serveMcp } from "./mcp.ts";
import { makeLogger } from "./secrets.ts";
import { loadLogins, storeDir } from "./store.ts";

const USAGE = `Usage: login-agent <command>

  bw-import    List the login items in Bitwarden, or pick one to import with fzf
  bw-import <id> [--alias <alias>] [--origin <origin>]...
               Copy one of them, encrypted, into ${storeDir()}
  list         Show stored aliases and their origins
  mcp --cdp-endpoint <url>
               Serve MCP over stdio, filling in the Chrome at <url>
`;

async function bwImport(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { alias: { type: "string" }, origin: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  const [item, ...extra] = positionals;
  if (extra.length) throw new Error("bw-import takes one item at a time");
  if (!item) {
    if (values.alias || values.origin) throw new Error("--alias and --origin need an item to import");
    return pickBitwardenLogin();
  }
  await importLogin({ item, alias: values.alias, origins: values.origin });
}

async function list(): Promise<void> {
  const logins = await loadLogins();
  if (!Object.keys(logins).length) console.log("No logins yet. Run `login-agent bw-import`.");
  for (const [alias, login] of Object.entries(logins)) {
    console.log(`${alias}: ${login.origins.join(", ")}${login.totp ? " (TOTP)" : ""}`);
  }
}

async function mcp(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { "cdp-endpoint": { type: "string" } } });
  const cdpUrl = values["cdp-endpoint"];
  if (!cdpUrl) throw new Error("mcp needs --cdp-endpoint <url>");
  await serveMcp({ cdpUrl, log: makeLogger() });
}

const commands: Record<string, (args: string[]) => Promise<void>> = { "bw-import": bwImport, list, mcp };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  process.stderr.write(USAGE);
  process.exit(process.argv[2] ? 1 : 0);
}
command(process.argv.slice(3)).catch((error: unknown) => {
  console.error(`login-agent: ${(error as Error)?.message ?? error}`);
  process.exit(1);
});
