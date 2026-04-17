import { createHash } from "crypto";

const maxFingerprintLength = 255;
const maxBrowserLabelLength = 160;

export function normalizeBrowserFingerprint(
  fingerprint: string | null | undefined,
): string | null {
  if (typeof fingerprint !== "string") {
    return null;
  }

  const normalized = fingerprint.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > maxFingerprintLength) {
    return normalized.slice(0, maxFingerprintLength);
  }

  return normalized;
}

export function normalizeBrowserLabel(
  browserLabel: string | null | undefined,
): string | null {
  if (typeof browserLabel !== "string") {
    return null;
  }

  const normalized = browserLabel.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > maxBrowserLabelLength) {
    return normalized.slice(0, maxBrowserLabelLength);
  }

  return normalized;
}

export function hashBrowserFingerprint(fingerprint: string): string {
  const pepper = process.env.FACE_ID_FINGERPRINT_PEPPER?.trim() ?? "";
  return createHash("sha256")
    .update(`${pepper}:${fingerprint}`)
    .digest("hex");
}
