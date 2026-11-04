import { type Browser, chromium, type ElementHandle, errors, type Page } from "playwright-core";
import { type Logger, scrub } from "./secrets.ts";
import type { Login } from "./store.ts";
import { generateTotp, totpSecretForms } from "./totp.ts";

const NON_TEXT_TYPES = ["password", "hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"];
const NOT_TEXT = NON_TEXT_TYPES.map((type) => `:not([type="${type}" i])`).join("");
const textInputs = (selectors: string[]) => selectors.map((s) => `${s}${NOT_TEXT}`).join(", ");

const USERNAME_SELECTOR = textInputs([
  'input[autocomplete~="username" i]',
  'input[type="email"]',
  'input[name="identifier"]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="login" i]',
  'input[name="email"]',
]);

const PASSWORD_SELECTOR = 'input[type="password"]';

const TOTP_SELECTOR = textInputs([
  'input[autocomplete="one-time-code" i]',
  'input[name*="otp" i]',
  'input[name*="totp" i]',
  'input[name*="passcode" i]',
  'input[name*="code" i]',
  'input[id*="otp" i]',
  'input[inputmode="numeric"]',
]);

/** Every message the agent can get back from a fill. None of them carry a secret. */
export const messages = {
  unknownAlias: (alias: string) => `Unknown login "${alias}". Call list_logins to see what is available.`,
  chromeUnreachable: () =>
    "Could not connect to Chrome over CDP. Is the agent's Chrome running with remote debugging on? A frozen tab can also cause this.",
  noTab: (alias: string, origins: string[]) =>
    `No open tab is on an allowed origin for "${alias}" (${origins.join(", ")}). Navigate to the login page first.`,
  manyTabs: (alias: string) =>
    `More than one visible tab is on an allowed origin for "${alias}". Close the extras and try again.`,
  noField: () =>
    "No username, password, or verification code field was found on this page. Take a snapshot; you may need to click a sign-in link or choose an authenticator first.",
  missing: (alias: string, what: string) => `"${alias}" has no ${what} stored. Import it again from Bitwarden.`,
  submitted: (what: string) =>
    `${what} filled and submitted. Take a snapshot; if the site asks for more, call fill again.`,
  stillShowing: () =>
    "Submitted, but the form is still showing (wrong credentials, a captcha, or another step). The field was cleared. Take a snapshot.",
  timedOut: () => "The fill took too long and was stopped. The page may be frozen. Take a snapshot.",
  pageChanged: () => "The page changed or left the allowed origin during the fill, so the fill was stopped.",
  failed: (detail: string) => `The fill failed: ${detail}`,
};

class PageChangedError extends Error {}

const PAGE_GONE_PATTERN =
  /Execution context was destroyed|not attached to the DOM|Target (page, context or browser|closed)|frame was detached|navigat/i;

export interface FillerOptions {
  cdpUrl: string;
  log: Logger;
  /** How long to wait for the form to go away after submit. */
  submitTimeoutMs?: number;
  /** Upper bound on one fill after connecting; past it the CDP connection is dropped and the fill fails. */
  fillTimeoutMs?: number;
}

export class Filler {
  #cdpUrl: string;
  #log: Logger;
  #submitTimeoutMs: number;
  #fillTimeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FillerOptions) {
    this.#cdpUrl = options.cdpUrl;
    this.#log = options.log;
    this.#submitTimeoutMs = options.submitTimeoutMs ?? 10_000;
    this.#fillTimeoutMs = options.fillTimeoutMs ?? 30_000;
  }

  /** Fills whatever the current page asks for: username and password, a username alone, or a TOTP code. */
  fill(alias: string, login: Login): Promise<string> {
    // Fills are serialized so two calls never type into the same page at once.
    const task = async () => {
      const secrets = [login.username, login.password, ...(login.totp ? totpSecretForms(login.totp) : [])];
      const result = scrub(await this.#fill(alias, login, secrets), secrets);
      this.#log(`fill ${alias}: ${result}`);
      return result;
    };
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #fill(alias: string, login: Login, secrets: (string | undefined)[]): Promise<string> {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(this.#cdpUrl, { timeout: 5000 });
    } catch (error) {
      this.#log(`CDP connect failed: ${describe(error, secrets)}`);
      return messages.chromeUnreachable();
    }
    // Disconnecting rejects every pending CDP call, so the fill itself ends and the queue never runs two at once.
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      browser.close().catch(() => {});
    }, this.#fillTimeoutMs);
    try {
      const result = await this.#fillPage(browser, alias, login, secrets);
      return timedOut ? messages.timedOut() : result;
    } catch (error) {
      if (timedOut) return messages.timedOut();
      if (error instanceof PageChangedError || PAGE_GONE_PATTERN.test(String((error as Error)?.message))) {
        return messages.pageChanged();
      }
      return messages.failed(describe(error, secrets));
    } finally {
      clearTimeout(deadline);
      // On a CDP connection this only disconnects; the user's Chrome keeps running.
      await browser.close().catch(() => {});
    }
  }

  async #fillPage(browser: Browser, alias: string, login: Login, secrets: (string | undefined)[]): Promise<string> {
    const allowed = new Set(login.origins);
    const page = await findTab(browser, allowed);
    if (page === "none") return messages.noTab(alias, login.origins);
    if (page === "many") return messages.manyTabs(alias);

    const passwordField = await findField(page, PASSWORD_SELECTOR);
    const userField = await findField(page, USERNAME_SELECTOR);
    if (passwordField) {
      if (!login.password) return messages.missing(alias, "password");
      if (userField && login.username) await guardedFill(page, userField, login.username, allowed);
      await guardedFill(page, passwordField, login.password, allowed);
      return await this.#submit(page, passwordField, PASSWORD_SELECTOR, allowed, "Password");
    }
    if (userField) {
      if (!login.username) return messages.missing(alias, "username");
      await guardedFill(page, userField, login.username, allowed);
      return await this.#submit(page, userField, USERNAME_SELECTOR, allowed, "Username");
    }
    const totpField = await findField(page, TOTP_SELECTOR);
    if (totpField) {
      if (!login.totp) return messages.missing(alias, "TOTP seed");
      const code = generateTotp(login.totp);
      secrets.push(code);
      await guardedFill(page, totpField, code, allowed);
      return await this.#submit(page, totpField, TOTP_SELECTOR, allowed, "Verification code");
    }
    return messages.noField();
  }

  /** Presses Enter, then waits for the field to go away; clears it if it is still (or again) showing. */
  async #submit(
    page: Page,
    field: ElementHandle,
    selector: string,
    allowed: Set<string>,
    what: string,
  ): Promise<string> {
    await assertOrigins(page, field, allowed);
    await field.press("Enter");

    if (!(await waitGone(field, this.#submitTimeoutMs))) {
      await field.fill("").catch(() => {});
      return messages.stillShowing();
    }
    // A full-page post that re-renders the same form detaches the old field, so look again.
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await sleep(500);
    const again = await findField(page, selector).catch(() => null);
    if (again) {
      await again.fill("").catch(() => {});
      return messages.stillShowing();
    }
    return messages.submitted(what);
  }
}

function describe(error: unknown, secrets: (string | undefined)[]): string {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright appends a multi-line call log; the first line is the useful part.
  const firstLine = message.split("\nCall log:")[0]!.split("\n")[0]!.trim();
  return scrub(firstLine, secrets).slice(0, 300);
}

async function findTab(browser: Browser, allowed: Set<string>): Promise<Page | "none" | "many"> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const matching = pages.filter((page) => allowed.has(originOf(page.url())));
  if (matching.length === 0) return "none";
  if (matching.length === 1) return matching[0]!;
  const states = await Promise.all(
    matching.map((page) => page.evaluate(() => document.visibilityState).catch(() => "hidden")),
  );
  const visible = matching.filter((_, i) => states[i] === "visible");
  return visible.length === 1 ? visible[0]! : "many";
}

async function findField(page: Page, selector: string): Promise<ElementHandle | null> {
  const candidates = await page.locator(selector).filter({ visible: true }).elementHandles();
  for (const handle of candidates) {
    if (await handle.isEditable()) return handle;
  }
  return null;
}

/** Checks the top page and the element's own document are on an allowed origin, then types. */
async function guardedFill(page: Page, field: ElementHandle, value: string, allowed: Set<string>): Promise<void> {
  await assertOrigins(page, field, allowed);
  await field.fill(value);
}

async function assertOrigins(page: Page, element: ElementHandle, allowed: Set<string>): Promise<void> {
  const topOrigin = await page.evaluate(() => location.origin);
  const fieldDoc = await element.evaluate((el) => ({
    origin: el.ownerDocument?.defaultView?.location.origin ?? "null",
    connected: el.isConnected,
  }));
  if (
    !allowed.has(originOf(page.url())) ||
    !allowed.has(topOrigin) ||
    !fieldDoc.connected ||
    !allowed.has(fieldDoc.origin)
  ) {
    throw new PageChangedError("page changed");
  }
}

async function waitGone(field: ElementHandle, timeoutMs: number): Promise<boolean> {
  try {
    await field.waitForElementState("hidden", { timeout: timeoutMs });
    return true;
  } catch (error) {
    return !(error instanceof errors.TimeoutError);
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
