/**
 * Type declarations for the plain-JS deterministic build fingerprint module.
 * Kept as .d.ts (not bundled) so Node unit tests can import the .mjs source
 * directly while tsc still checks the call sites.
 */
export function listExtensionFingerprintInputs(repoRoot: string): string[];
export function listExtensionConsumedSharedSources(repoRoot: string): string[];
export function computeExtensionBuildId(repoRoot: string): string;
