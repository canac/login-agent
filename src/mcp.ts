// The SDK's wildcard export maps types to *.js.d.ts, which don't exist, so point Deno at the real ones.
// @ts-types="@modelcontextprotocol/sdk/server/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-types="@modelcontextprotocol/sdk/server/stdio"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import config from "../deno.json" with { type: "json" };
import { Filler, messages } from "./fill.ts";
import type { Logger } from "./secrets.ts";
import { loadLogins } from "./store.ts";

const { version } = config;

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

/** Serves MCP over stdio. The logins file is read on every call, so a new import needs no restart. */
export async function serveMcp(options: { cdpUrl: string; log: Logger }): Promise<void> {
  const filler = new Filler(options);
  const server = new McpServer({ name: "login-agent", version });

  server.registerTool(
    "list_logins",
    {
      description:
        "List the logins login-agent can fill: alias, the origins each may be filled on, and whether it has a TOTP code. Contains no credentials.",
      inputSchema: {},
    },
    async () => {
      const logins = await loadLogins();
      const list = Object.fromEntries(
        Object.entries(logins).map((
          [alias, login],
        ) => [alias, { origins: login.origins, hasTotp: Boolean(login.totp) }]),
      );
      return text(JSON.stringify(list, null, 2));
    },
  );

  server.registerTool(
    "fill",
    {
      description:
        "Fill and submit whatever the current login page asks for, for one login: username and password, a username alone, or a TOTP verification code. It works in the one tab that is on one of the login's origins. Navigate there first; on multi-page logins call fill once per page, choosing options like the authenticator yourself. Take a snapshot after each call. You will never see the credentials, only an outcome message.",
      inputSchema: { alias: z.string().describe("A login alias from list_logins") },
    },
    async ({ alias }) => {
      const logins = await loadLogins();
      const login = Object.hasOwn(logins, alias) ? logins[alias] : undefined;
      if (!login) return text(messages.unknownAlias(alias));
      return text(await filler.fill(alias, login));
    },
  );

  await server.connect(new StdioServerTransport());
  options.log(`login-agent MCP server ready (Chrome at ${options.cdpUrl})`);
}
