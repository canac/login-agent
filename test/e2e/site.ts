// Local login pages for end-to-end tests. Two copies run on different ports so one can be the wrong origin.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Submission {
  site: string;
  path: string;
  form: Record<string, string>;
}

export interface Site {
  right: string;
  wrong: string;
  submissions: Submission[];
  close(): Promise<void>;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const loginForm = (action: string) =>
  `<form method="post" action="${action}">
<label>Username <input type="text" name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Log in</button></form>`;

const emailForm = (action: string) =>
  `<form method="post" action="${action}">
<label>Email <input type="email" name="email" autocomplete="username"></label>
<button type="submit">Next</button></form>`;

const pages: Record<string, (url: URL) => string> = {
  "/login": () => page("Sign in", loginForm("/login")),
  "/stuck": () => page("Sign in", loginForm("/stuck")),
  "/two-step": () => page("Sign in: step 1", emailForm("/two-step/email")),
  "/hijack": () => page("Sign in: step 1", emailForm("/hijack/email")),
  "/two-step/password": (url) =>
    page(
      "Sign in: step 2",
      `<form method="post" action="/two-step/password">
<input type="hidden" name="email" value="${escape(url.searchParams.get("email") ?? "")}">
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<input type="submit" name="login" value="Sign in"></form>`,
    ),
  "/otp": () =>
    page(
      "Two-factor verification",
      `<form method="post" action="/otp">
<label>Verification code <input type="text" name="otp" inputmode="numeric" autocomplete="one-time-code"></label>
<button type="submit">Verify</button></form>`,
    ),
};

function readForm(req: import("node:http").IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  );
}

export async function startSite(): Promise<Site> {
  const submissions: Submission[] = [];
  let wrongOrigin = "";

  const handler =
    (site: string) => async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "POST") {
        const form = await readForm(req);
        submissions.push({ site, path: url.pathname, form });
        const email = encodeURIComponent(form.email ?? "");
        if (url.pathname === "/two-step/email" || url.pathname === "/hijack/email") {
          // The hijack variant sends step 2 to the other origin, like a compromised or look-alike redirect.
          const base = url.pathname === "/hijack/email" ? wrongOrigin : "";
          res.writeHead(303, { location: `${base}/two-step/password?email=${email}` });
          res.end();
          return;
        }
        if (url.pathname === "/stuck") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(page("Sign in", `<p>Wrong password.</p>${loginForm("/stuck")}`));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page("Signed in", `<p id="result">Received ${url.pathname} on ${site}.</p>`));
        return;
      }
      if (url.pathname === "/bait") {
        // Leaves for the other origin the moment the username is typed, before the password is.
        const script =
          `<script>document.querySelector('[name=username]').addEventListener('input', () => location.replace(${
            JSON.stringify(`${wrongOrigin}/login`)
          }))</script>`;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page("Sign in", loginForm("/bait") + script));
        return;
      }
      if (url.pathname === "/frozen") {
        // Hangs the renderer once the fill focuses the username, so every later CDP call into the page stalls.
        const script =
          "<script>document.querySelector('[name=username]').addEventListener('focus', () => { for (;;) {} })</script>";
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page("Sign in", loginForm("/frozen") + script));
        return;
      }
      const render = pages[url.pathname];
      if (!render) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      const html = render(url);
      res.end(site === "wrong" ? html.replace("<h1>", "<h1>WRONG SITE: ") : html);
    };

  const rightServer = createServer(handler("right"));
  const wrongServer = createServer(handler("wrong"));
  const right = await listen(rightServer);
  wrongOrigin = await listen(wrongServer);

  return {
    right,
    wrong: wrongOrigin,
    submissions,
    close: async () => {
      rightServer.closeAllConnections();
      wrongServer.closeAllConnections();
      await Promise.all([rightServer, wrongServer].map((s) => new Promise((r) => s.close(r))));
    },
  };
}
