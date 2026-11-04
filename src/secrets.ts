const REDACTED = "[redacted]";

/** Replaces every secret in `text`. Values under 4 characters are skipped so a short username can't blank out ordinary words. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  const values = new Set(secrets.filter((value): value is string => value !== undefined && value.length >= 4));
  // Longest first so a secret that contains another is removed whole.
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) out = out.split(value).join(REDACTED);
  return out;
}

export type Logger = (message: string) => void;

export function makeLogger(write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  return (message) => write(`${new Date().toISOString()} ${message}\n`);
}
