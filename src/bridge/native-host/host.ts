import * as net from "node:net";
import * as stream from "node:stream";
import { BridgeError } from "../BridgeError.js";
import { encodeNativeMessage, NativeFrameDecoder } from "../nativeFraming.js";
import { parseNativeHostArgs } from "../nativeHostArgs.js";
import { BRIDGE_PROTOCOL_VERSION } from "../protocol.js";
import type { BridgeMessage } from "../protocol.js";
import { parseBridgeMessage } from "../protocol.js";
import { defaultIsPidAlive, isSessionStale, loadSessionDescriptor } from "../session.js";
import type { BridgeSession } from "../session.js";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export interface HostRunOptions {
  /** process.argv.slice(2) from Chrome: origin + --parent-window. */
  readonly argv: string[];
  /** Exact expected origin, e.g. chrome-extension://<id>/ */
  readonly expectedOrigin: string;
  /** Loads the active session descriptor (null when absent). */
  readonly loadSession: () => Promise<BridgeSession | null>;
  readonly stdin: stream.Readable;
  readonly stdout: stream.Writable;
  readonly log: (message: string) => void;
  readonly connectPipe?: (pipeName: string) => Promise<net.Socket>;
  readonly helloTimeoutMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  /**
   * Dev-diagnostic launch/exit journal (file path). Every host start appends
   * its argv and every exit appends its code, so browser-launched runs (whose
   * stderr is invisible) leave observable evidence. Never receives secrets:
   * only argv, codes, and safe messages are recorded.
   */
  readonly journalPath?: string;
}

/** Production session loader: reads and validates the session file. */
export function fileSessionLoader(sessionPath: string): () => Promise<BridgeSession | null> {
  return () => loadSessionDescriptor((filePath) => readFile(filePath, "utf-8"), sessionPath);
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000;

/**
 * Native Messaging relay (browser-launched, owns neither side long-term).
 *
 * Validates the caller origin, loads the active MCP session, authenticates
 * to the MCP named pipe with the session nonce, then forwards validated
 * envelopes both ways with end-to-end correlation IDs. Contains no browser
 * business logic and never launches, edits, or inspects anything else.
 *
 * Exit codes: 0 clean (stdin EOF after serving or nothing to do);
 * 1 origin rejected; 2 session missing/corrupt; 3 session stale;
 * 4 pipe connect failed; 5 hello rejected/timeout; 6 framing/protocol fatal.
 */
export async function runHost(options: HostRunOptions): Promise<number> {
  const code = await runHostInner(options);
  if (options.journalPath !== undefined) {
    try {
      appendFileSync(options.journalPath, `${new Date().toISOString()} pid=${String(process.pid)} exit=${String(code)}\n`);
    } catch {
      // Journaling must never break the relay.
    }
  }
  return code;
}

function journalStart(options: HostRunOptions): void {
  if (options.journalPath === undefined) {
    return;
  }
  try {
    appendFileSync(
      options.journalPath,
      `${new Date().toISOString()} pid=${String(process.pid)} start argv=${JSON.stringify(options.argv)}\n`,
    );
  } catch {
    // Journaling must never break the relay.
  }
}

async function runHostInner(options: HostRunOptions): Promise<number> {
  const rawLog = options.log;
  const log = (message: string): void => {
    rawLog(message);
    // Mirror safe diagnostics into the journal: host stderr is invisible
    // when the browser launches the host, so the journal is the only failure record.
    // Log call sites never include secrets (no nonces, no tokens).
    if (options.journalPath !== undefined) {
      try {
        appendFileSync(options.journalPath, `${new Date().toISOString()} pid=${String(process.pid)} log ${message}\n`);
      } catch {
        // Journaling must never break the relay.
      }
    }
  };
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  journalStart(options);

  let origin: string;
  try {
    origin = parseNativeHostArgs(options.argv, options.expectedOrigin).origin;
  } catch (error: unknown) {
    log(`refusing caller: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let session;
  try {
    const loaded = await options.loadSession();
    if (loaded === null) {
      log("no active bridge session; is the MCP process running?");
      return 2;
    }
    session = loaded;
  } catch (error: unknown) {
    log(`unreadable bridge session: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (isSessionStale(session, isPidAlive)) {
    log("bridge session is stale (owner process gone); waiting for a fresh MCP session");
    return 3;
  }

  const connectPipe =
    options.connectPipe ??
    ((pipeName: string) =>
      new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(pipeName);
        socket.once("connect", () => resolve(socket));
        socket.once("error", (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }));
  let pipe: net.Socket;
  try {
    pipe = await connectPipe(session.pipeName);
  } catch (error: unknown) {
    log(`cannot reach MCP pipe ${session.pipeName}: ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }

  const authenticated = await authenticatePipe(pipe, session.nonceHex, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS, log);
  if (!authenticated) {
    pipe.destroy();
    return 5;
  }
  log(`relay established for ${origin}`);

  const exitCode = await relayLoop(options.stdin, options.stdout, pipe, log);
  pipe.destroy();
  return exitCode;
}
interface PendingHello {
  resolve: (ok: boolean) => void;
}

async function authenticatePipe(
  pipe: net.Socket,
  nonceHex: string,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<boolean> {
  // Hello handshake on the pipe: small fixed shapes in both directions.
  const decoder = new NativeFrameDecoder("small");
  const helloId = "host-hello";
  const outcome = new Promise<boolean>((resolve) => {
    const pending: PendingHello = {
      resolve: (ok: boolean) => {
        cleanup();
        resolve(ok);
      },
    };
    const timer = setTimeout(() => {
      log("MCP hello timed out");
      pending.resolve(false);
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      pipe.off("data", onData);
    };
    const onData = (chunk: Buffer): void => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error: unknown) {
        log(`pipe framing error during hello: ${error instanceof Error ? error.message : String(error)}`);
        pending.resolve(false);
        return;
      }
      for (const frame of frames) {
        let message: BridgeMessage;
        try {
          message = parseBridgeMessage(frame);
        } catch (error: unknown) {
          log(`pipe protocol error during hello: ${error instanceof Error ? error.message : String(error)}`);
          pending.resolve(false);
          return;
        }
        if (message.type === "response" && message.id === helloId) {
          pending.resolve(message.ok);
          return;
        }
      }
    };
    pipe.on("data", onData);
    pipe.write(
      encodeNativeMessage(
        {
          version: BRIDGE_PROTOCOL_VERSION,
          id: helloId,
          type: "request",
          method: "bridge.hello",
          payload: { nonce: nonceHex, bridgeVersion: BRIDGE_PROTOCOL_VERSION },
        },
        "small",
      ),
    );
  });
  return outcome;
}

/**
 * Bidirectional forward validated frames between Chrome stdio and the MCP
 * pipe until stdin EOF. Malformed input on either side ends the relay with
 * a fatal code; clean EOF ends it with 0.
 */
function relayLoop(
  stdin: stream.Readable,
  stdout: stream.Writable,
  pipe: net.Socket,
  log: (message: string) => void,
): Promise<number> {
  return new Promise<number>((resolve) => {
    // Directional decoders. Chrome stdio stdin carries
    // extension->host traffic: overwhelmingly extension-originated
    // RESPONSES (the screenshot direction, 64 MiB platform cap), so the
    // LARGE response bound applies here. The named-pipe read carries
    // server->host traffic: REQUESTS only, so the SMALL bound applies.
    // Note: stdio cannot distinguish an extension-initiated request from a
    // response at framing time; such requests stay rejected at the RPC
    // layer (MCP serves nothing but bridge.hello), and the extension is
    // first-party shipped code, so the 16 MiB bound is still a hard cap on
    // allocation, not an open door.
    const stdinDecoder = new NativeFrameDecoder("large-response");
    const pipeDecoder = new NativeFrameDecoder("small");
    let settled = false;
    const finish = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      stdin.off("data", onStdinData);
      stdin.off("end", onStdinEnd);
      pipe.off("data", onPipeData);
      pipe.off("close", onPipeClose);
      // Release stdio/pipe handles so the process can actually exit after
      // relay end; a resumed stdin alone would pin the event loop forever
      // and leave orphaned host processes behind.
      stdin.pause();
      const unref = (s: unknown): void => {
        const maybe = s as { unref?: () => void };
        try {
          maybe.unref?.();
        } catch {
          // Best effort only.
        }
      };
      unref(stdin);
      unref(pipe);
      resolve(code);
    };
    const forwardToPipe = (frame: unknown): boolean => {
      let message: BridgeMessage;
      try {
        message = parseBridgeMessage(frame);
      } catch (error: unknown) {
        log(`native protocol error: ${error instanceof Error ? error.message : String(error)}`);
        finish(6);
        return false;
      }
      // Re-encode the validated envelope (canonical bytes, same content).
      // Direction extension->host->pipe: responses may be LARGE (future
      // screenshots); requests are small by construction. Never log the
      // body: only bounded metadata travels with transport errors.
      let encoded: Buffer;
      try {
        encoded = encodeNativeMessage(message, "large-response");
      } catch (error: unknown) {
        // Diagnostic metadata only: direction, declared/encoded size, and
        // limit. No payload, no base64, no source text, no raw frame body.
        if (error instanceof BridgeError && error.code === "NATIVE_FRAME_TOO_LARGE") {
          log(
            `oversized extension response rejected (direction=extension->pipe declaredBytes=${error.details["bytes"] ?? "?"} maxBytes=${String(16 * 1024 * 1024)})`,
          );
        } else {
          log(`native framing error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finish(6);
        return false;
      }
      pipe.write(encoded);
      return true;
    };
    const forwardToNative = (frame: unknown): boolean => {
      let message: BridgeMessage;
      try {
        message = parseBridgeMessage(frame);
      } catch (error: unknown) {
        log(`pipe protocol error: ${error instanceof Error ? error.message : String(error)}`);
        finish(6);
        return false;
      }
      // Direction server->host->extension: REQUESTS only, always SMALL.
      // This must stay far below the 1 MiB host->extension platform cap.
      // Oversized responses must never route back this way.
      let encoded: Buffer;
      try {
        encoded = encodeNativeMessage(message, "small");
      } catch (error: unknown) {
        if (error instanceof BridgeError && error.code === "NATIVE_FRAME_TOO_LARGE") {
          log(
            `oversized server request rejected (direction=pipe->extension declaredBytes=${error.details["bytes"] ?? "?"} maxBytes=${String(256 * 1024)})`,
          );
        } else {
          log(`pipe framing error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finish(6);
        return false;
      }
      stdout.write(encoded);
      return true;
    };
    const onStdinData = (chunk: Buffer): void => {
      let frames: unknown[];
      try {
        frames = stdinDecoder.push(chunk);
      } catch (error: unknown) {
        // Error carries bounded metadata (declared/max bytes) from the
        // codec; never the body. A malformed or oversized extension frame
        // ends the relay with code 6 rather than crashing the host.
        log(`native framing error: ${error instanceof Error ? error.message : String(error)}`);
        finish(6);
        return;
      }
      for (const frame of frames) {
        if (!forwardToPipe(frame)) {
          return;
        }
      }
    };
    const onStdinEnd = (): void => {
      log("native stdin ended; relay closing cleanly");
      finish(0);
    };
    const onPipeData = (chunk: Buffer): void => {
      let frames: unknown[];
      try {
        frames = pipeDecoder.push(chunk);
      } catch (error: unknown) {
        log(`pipe framing error: ${error instanceof Error ? error.message : String(error)}`);
        finish(6);
        return;
      }
      for (const frame of frames) {
        if (!forwardToNative(frame)) {
          return;
        }
      }
    };
    const onPipeClose = (): void => {
      log("MCP pipe closed; relay closing");
      finish(0);
    };
    stdin.on("data", onStdinData);
    stdin.on("end", onStdinEnd);
    pipe.on("data", onPipeData);
    pipe.on("close", onPipeClose);
  });
}
