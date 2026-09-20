import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/bridge/BridgeError.js";
import { extensionIdFromPublicKeyBase64, extensionOrigin } from "../src/bridge/extensionIdentity.js";
import {
  createSession,
  defaultIsPidAlive,
  defaultSessionDir,
  isSessionStale,
  loadSessionDescriptor,
  parseSessionDescriptor,
  removeSessionFile,
  writeSessionAtomic,
} from "../src/bridge/session.js";

describe("bridge session descriptor", () => {
  it("creates a 256-bit nonce session", () => {
    const session = createSession("\\\\.\\pipe\\test", 1234);
    expect(session.nonceHex).toMatch(/^[0-9a-f]{64}$/);
    expect(session.version).toBe(1);
    expect(session.mcpPid).toBe(1234);
  });

  it("round-trips through an atomic write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-session-"));
    try {
      const file = path.join(dir, "bridge-session.json");
      const session = createSession("\\\\.\\pipe\\test", process.pid);
      await writeSessionAtomic(file, session);
      const loaded = await loadSessionDescriptor((filePath) => readFile(filePath, "utf-8"), file);
      expect(loaded).toEqual(session);
      await removeSessionFile(file);
      expect(await loadSessionDescriptor((filePath) => readFile(filePath, "utf-8"), file)).toBeNull();
      await removeSessionFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed descriptors with typed errors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "arc-mcp-session-"));
    try {
      const file = path.join(dir, "bridge-session.json");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, "{oops", "utf-8");
      await expect(loadSessionDescriptor((filePath) => readFile(filePath, "utf-8"), file)).rejects.toBeInstanceOf(BridgeError);
      await writeFile(file, JSON.stringify({ version: 2 }), "utf-8");
      let caught: unknown = null;
      try {
        await loadSessionDescriptor((filePath) => readFile(filePath, "utf-8"), file);
      } catch (error: unknown) {
        caught = error;
      }
      expect((caught as BridgeError).code).toBe("SESSION_CORRUPT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects stale sessions by owner liveness, not blind trust", () => {
    const live = createSession("p", process.pid);
    const dead = createSession("p", 2_000_000_000);
    expect(isSessionStale(live, () => true)).toBe(false);
    expect(isSessionStale(dead, () => false)).toBe(true);
  });

  it("defaultIsPidAlive treats own PID alive and absurd PIDs dead", () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
    expect(defaultIsPidAlive(2_000_000_000)).toBe(false);
  });

  it("requires LOCALAPPDATA for the default session dir", () => {
    expect(() => defaultSessionDir({})).toThrow(BridgeError);
    expect(defaultSessionDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toBe(
      "C:\\Users\\x\\AppData\\Local\\arc-mcp\\sessions",
    );
  });

  it("rejects invalid inline descriptors", () => {
    expect(() => parseSessionDescriptor("null")).toThrow(BridgeError);
  });
});

describe("extension identity derivation", () => {
  it("is deterministic, well-formed, and sensitive to key material", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    type RsaDerPem = import("node:crypto").RSAKeyPairOptions<"der", "pem">;
    const makePublicKey = (): Buffer => {
      const options: RsaDerPem = {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      };
      const { publicKey } = generateKeyPairSync("rsa", options);
      return Buffer.from(publicKey);
    };
    const first = makePublicKey();
    const second = makePublicKey();
    const keyB64 = first.toString("base64");
    const idA = extensionIdFromPublicKeyBase64(keyB64);
    const idB = extensionIdFromPublicKeyBase64(`  ${keyB64}  `);
    expect(idA).toBe(idB);
    expect(idA).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromPublicKeyBase64(second.toString("base64"))).not.toBe(idA);
    expect(extensionOrigin(idA)).toBe(`chrome-extension://${idA}/`);
    expect(() => extensionIdFromPublicKeyBase64("")).toThrow();
  });

  it("committed identity.json yields a well-formed deterministic ID", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("extension/identity.json", "utf-8");
    const parsed = JSON.parse(raw) as { publicKey?: unknown };
    expect(typeof parsed.publicKey).toBe("string");
    const id = extensionIdFromPublicKeyBase64(parsed.publicKey as string);
    expect(id).toMatch(/^[a-p]{32}$/);
  });
});

