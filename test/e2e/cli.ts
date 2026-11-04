import { join } from "node:path";

const root = join(import.meta.dirname!, "../..");

// Same permissions as the installed command, so a missing grant fails here too.
export const cli = {
  command: Deno.execPath(),
  args: (...args: string[]) => [
    "run",
    "--quiet",
    "--frozen",
    `--config=${join(root, "deno.json")}`,
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-sys",
    "--allow-run=bw,fzf",
    join(root, "src/cli.ts"),
    ...args,
  ],
};
