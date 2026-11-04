import { Secret, TOTP, URI } from "otpauth";

/** Parses a base32 seed or an otpauth://totp URL. Throws on anything else. */
export function parseTotp(spec: string): TOTP {
  const trimmed = spec.trim();
  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const otp = URI.parse(trimmed);
    if (!(otp instanceof TOTP)) {
      throw new Error("otpauth URL must be a TOTP URL, not HOTP");
    }
    return otp;
  }
  const base32 = trimmed.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+=*$/.test(base32)) {
    throw new Error("TOTP seed must be base32 or an otpauth:// URL");
  }
  return new TOTP({ secret: Secret.fromBase32(base32) });
}

export function generateTotp(spec: string, timestamp = Date.now()): string {
  return parseTotp(spec).generate({ timestamp });
}

/** The raw strings a seed can appear as, for scrubbing. */
export function totpSecretForms(spec: string): string[] {
  const otp = parseTotp(spec);
  return [spec, spec.trim(), otp.secret.base32, otp.toString()];
}
