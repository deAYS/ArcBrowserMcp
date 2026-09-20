import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ID_ALPHABET = "abcdefghijklmnop";

export interface ExtensionIdentity {
  /** base64-encoded DER SubjectPublicKeyInfo from extension/identity.json. */
  readonly publicKeyBase64: string;
  /** Deterministic extension ID derived with the Chromium algorithm. */
  readonly extensionId: string;
}

/**
 * Derive a Chromium extension ID from a base64 SPKI public key.
 *
 * Chromium algorithm: SHA-256 over the DER bytes, first 128 bits mapped
 * nibble-by-nibble onto [a-p]. Do not "improve" this mapping.
 */
export function extensionIdFromPublicKeyBase64(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64.trim(), "base64");
  if (der.length === 0) {
    throw new Error("extension identity public key is empty");
  }
  const digest = createHash("sha256").update(der).digest();
  const nibble = (index: number): number => {
    const byte = digest[index];
    if (byte === undefined) {
      throw new Error("sha256 digest unexpectedly short");
    }
    return byte;
  };
  const nibbleChar = (nibble: number): string => {
    const char = ID_ALPHABET[nibble & 0x0f];
    if (char === undefined) {
      throw new Error("extension ID alphabet unexpectedly short");
    }
    return char;
  };
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = nibble(i);
    id += nibbleChar(byte >> 4) + nibbleChar(byte);
  }
  return id;
}

/** Exact Native Messaging origin for an extension ID (trailing slash required). */
export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}/`;
}

interface IdentityFile {
  readonly publicKey?: unknown;
}

/** Load extension/identity.json relative to the repo root checkout. */
export function loadExtensionIdentity(repoRoot: string): ExtensionIdentity {
  const raw = readFileSync(`${repoRoot}/extension/identity.json`, "utf-8");
  const parsed = JSON.parse(raw) as IdentityFile;
  if (typeof parsed.publicKey !== "string" || parsed.publicKey.trim() === "") {
    throw new Error("extension/identity.json must contain a non-empty publicKey string");
  }
  return {
    publicKeyBase64: parsed.publicKey.trim(),
    extensionId: extensionIdFromPublicKeyBase64(parsed.publicKey),
  };
}
