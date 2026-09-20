/**
 * Directional frame bounds (P08T). Dependency-free on purpose: the
 * extension bundle imports this module, so no Node APIs and no other
 * project imports may appear here.
 *
 * The bridge carries two very different payload classes over the same
 * length-prefixed codec, so one symmetric cap cannot fit both:
 *
 * - SMALL (256 KiB): every command/request path and every host->extension
 *   message. Kept tight because the native-host->extension direction has a
 *   strict 1 MiB Chrome platform ceiling.
 * - LARGE (16 MiB): extension-originated responses only (host->server
 *   direction on the named pipe; extension->native-host on Chrome stdio).
 *   This is the screenshot-carrying direction: an 8 MiB decoded PNG expands
 *   to ~10.67 MiB base64 plus envelope JSON, so 16 MiB gives bounded margin
 *   while staying far below the 64 MiB Chrome platform cap that applies in
 *   the extension->host direction.
 *
 * No chunking, no streaming, no second connection: a single bounded frame
 * per message in every direction.
 */

/** Tight bound for all command/request paths (256 KiB). */
export const SMALL_FRAME_MAX_BYTES = 256 * 1024;

/** Legacy alias for the small request bound; prefer SMALL_FRAME_MAX_BYTES. */
export const MAX_BRIDGE_MESSAGE_BYTES = SMALL_FRAME_MAX_BYTES;

/**
 * Bound for extension-originated responses only (16 MiB). Must never be
 * applied to the host->extension request direction (1 MiB platform cap).
 */
export const LARGE_RESPONSE_FRAME_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Future P08 screenshot capability bound (8 MiB decoded PNG). Declared here
 * so transport and capability budgets stay consistent.
 */
export const SCREENSHOT_MAX_DECODED_BYTES = 8 * 1024 * 1024;
