/**
 * Shared snapshot semantics for P06 (Node + extension, dependency-free).
 *
 * This module owns the browser-neutral snapshot model: Accessibility-tree
 * normalization, compact text rendering, size bounds, opaque-ref syntax
 * validation, and the raw-CDP-leak scanner. It never touches chrome.*,
 * Node APIs, or the bridge, so the extension bundle can import it directly
 * (same precedent as navigationPolicy.ts) and unit tests run without a
 * browser.
 *
 * Design decisions (P06):
 * - Accessibility semantics are authoritative; raw HTML is never used and
 *   Runtime.evaluate is never needed.
 * - about:blank is deterministically NOT controllable (matches the
 *   isControllableUrl rule used by P04/P05).
 * - Latest-snapshot-only references: each successful capture invalidates
 *   earlier element refs for that tab (enforced extension-side in
 *   snapshot.ts; the syntax helpers here only validate shape).
 * - Password values are never exposed: textbox/searchbox nodes whose
 *   backend DOM node is a password input, or whose accessible name looks
 *   like a credential field, have their value redacted.
 */

export const SNAPSHOT_DEFAULT_MAX_NODES = 500;
export const SNAPSHOT_HARD_MAX_NODES = 1500;
export const SNAPSHOT_MAX_FIELD_CHARS = 200;
export const SNAPSHOT_MAX_TEXT_CHARS = 100_000;

/**
 * Hard cap over the complete serialized snapshot payload (UTF-8 bytes of
 * JSON.stringify of the exact result object, including structured node
 * fields, refs, semantic text, and snapshot metadata). Few-hundred-KiB
 * range so an adversarial page can never produce a multi-megabyte MCP
 * payload. Node count / per-field / text bounds alone do not bound the
 * complete payload (escaping + non-ASCII expansion), hence this cap.
 */
export const SNAPSHOT_MAX_SERIALIZED_BYTES = 256 * 1024;

/** Project-owned opaque element reference syntax: e-<32 hex session>-<base36 snap>-<base36 ctr>. */
export const ELEMENT_REF_PATTERN = /^e-[0-9a-f]{32}-[0-9a-z]+-[0-9a-z]+$/;
/** Snapshot generation syntax: s-<32 hex session>-<base36 snap>. */
export const SNAPSHOT_ID_PATTERN = /^s-[0-9a-f]{32}-[0-9a-z]+$/;

/** Roles that receive public opaque refs (actionable + useful targets). */
export const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "listbox",
  "heading",
]);

/** Structural roles flattened away when they carry no semantic content. */
const WRAPPER_ROLES = new Set(["generic", "group", "none", "presentation", "directory"]);

/** Roles whose value must be treated as potentially sensitive (fail closed). */
export const EDITABLE_VALUE_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

/** Raw CDP key names that must never appear in MCP-visible output. */
const LEAKED_CDP_KEYS = new Set(["backendNodeId", "backendDOMNodeId", "nodeId", "objectId"]);

const PASSWORD_NAME_PATTERN = /pass(word|code|phrase)|current-password|new-password|passwd|pwd|pin-code/i;

export interface SnapshotNode {
  readonly ref?: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly checked?: boolean | "mixed";
  readonly expanded?: boolean;
  readonly level?: number;
}

/** Loose view of one Accessibility.getFullAXTree node (unknown-shape input). */
export interface RawAxNode {
  readonly nodeId?: unknown;
  readonly backendDOMNodeId?: unknown;
  readonly ignored?: unknown;
  readonly role?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly value?: unknown;
  readonly properties?: unknown;
  readonly childIds?: unknown;
}

export interface NormalizeOptions {
  /**
   * Called only for ACTIONABLE_ROLES nodes that survive filtering.
   * Returns the opaque ref to publish, or null to publish without a ref.
   */
  readonly allocateRef: (axNodeId: string, role: string) => string | null;
  /**
   * Fail-closed value-redaction model for value-bearing editable controls.
   *
   * Per backend id, one of:
   * - "safe": positively established (via DOM.describeNode) as a
   *   non-password input -> value may be retained.
   * - "password": positively identified password -> redact.
   * - omitted/unknown: not positively established -> redact (fail closed).
   *   This covers describeNode failure, probe-budget exhaustion, missing
   *   backend node ids, and ambiguous editable/input types.
   *
   * Credential-name heuristics are defense in depth only, never the
   * primary boundary: even a benign-looking name with unknown status is
   * redacted above.
   */
  readonly valueSafety?: ReadonlyMap<number, "safe" | "password">;
  /** @deprecated Prefer valueSafety (fail closed). Kept for transition only. */
  readonly passwordBackendIds?: ReadonlySet<number>;
  /** Soft cap on emitted nodes; clamped to [1, SNAPSHOT_HARD_MAX_NODES]. */
  readonly maxNodes?: number;
  /** Hard cap on the final serialized payload (UTF-8 bytes); defaults to SNAPSHOT_MAX_SERIALIZED_BYTES. */
  readonly maxSerializedBytes?: number;
  /** Result envelope metadata needed to measure the full serialized payload budget. */
  readonly envelope?: {
    readonly snapshotId: string;
    readonly tabId: string;
    readonly url: string;
    readonly title: string;
  };
}

export interface NormalizeResult {
  readonly nodes: SnapshotNode[];
  readonly text: string;
  readonly truncated: boolean;
  /** Semantic nodes that would be emitted without the cap. */
  readonly totalNodes: number;
  readonly includedNodes: number;
}

function axString(field: unknown): string {
  if (typeof field === "string") {
    return field;
  }
  if (typeof field === "object" && field !== null) {
    const record = field as Record<string, unknown>;
    const value = record["value"];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return "";
}

function truncateField(value: string): string {
  return value.length > SNAPSHOT_MAX_FIELD_CHARS
    ? value.slice(0, SNAPSHOT_MAX_FIELD_CHARS)
    : value;
}

function propertyValue(properties: unknown, name: string): unknown {
  if (!Array.isArray(properties)) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const entry of properties) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["name"] === "string" && (record["name"] as string).toLowerCase() === wanted) {
      const value = record["value"];
      if (typeof value === "object" && value !== null) {
        return (value as Record<string, unknown>)["value"];
      }
      return value;
    }
  }
  return undefined;
}

function booleanProperty(properties: unknown, name: string): boolean | undefined {
  const value = propertyValue(properties, name);
  return typeof value === "boolean" ? value : undefined;
}

function checkedProperty(properties: unknown): boolean | "mixed" | undefined {
  const value = propertyValue(properties, "checked");
  if (value === "mixed") {
    return "mixed";
  }
  return typeof value === "boolean" ? value : undefined;
}

function levelProperty(properties: unknown): number | undefined {
  for (const name of ["level", "headinglevel", "hierarchicallevel"]) {
    const value = propertyValue(properties, name);
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
      return value;
    }
  }
  return undefined;
}

function displayRole(role: string): string {
  return role === "statictext" ? "text" : role;
}

/** True when the AX node itself carries password-like/protected semantics. */
function axPasswordSemantics(raw: RawAxNode): boolean {
  const properties = raw.properties;
  if (Array.isArray(properties)) {
    for (const entry of properties) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const propName = typeof record["name"] === "string" ? String(record["name"]).toLowerCase() : "";
      if (propName === "protected") {
        const inner = (record["value"] as Record<string, unknown> | undefined)?.["value"];
        const value = typeof inner === "boolean" ? inner : record["value"];
        if (value === true) {
          return true;
        }
      }
      if (propName === "autocomplete" || propName === "invalid" || propName === "roledescription") {
        const inner = (record["value"] as Record<string, unknown> | undefined)?.["value"];
        const text = typeof inner === "string" ? inner : typeof record["value"] === "string" ? String(record["value"]) : "";
        if (/password|current-password|new-password/i.test(text)) {
          return true;
        }
      }
    }
  }
  const roleText = axString(raw.role).trim().toLowerCase();
  const description = axString(raw.description).trim();
  if (/password/i.test(roleText) || /password/i.test(description)) {
    return true;
  }
  return false;
}

/** UTF-8 byte length of a string without Node APIs (extension-safe). */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Normalize a raw Accessibility node list into bounded semantic nodes plus
 * a compact text rendering. Ignored nodes are skipped with their children
 * spliced up; meaningless wrappers are flattened only when they carry no
 * accessible name/value/state of their own.
 */
export function normalizeAxTree(rawNodes: readonly RawAxNode[], options: NormalizeOptions): NormalizeResult {
  const maxNodes = Math.min(
    Math.max(Math.floor(options.maxNodes ?? SNAPSHOT_DEFAULT_MAX_NODES), 1),
    SNAPSHOT_HARD_MAX_NODES,
  );
  const byId = new Map<string, RawAxNode>();
  const order: string[] = [];
  for (const node of rawNodes) {
    const id = typeof node.nodeId === "string" ? node.nodeId : null;
    if (id === null || byId.has(id)) {
      continue;
    }
    byId.set(id, node);
    order.push(id);
  }
  const isChild = new Set<string>();
  for (const node of byId.values()) {
    if (Array.isArray(node.childIds)) {
      for (const child of node.childIds) {
        if (typeof child === "string" && byId.has(child)) {
          isChild.add(child);
        }
      }
    }
  }
  const roots = order.filter((id) => !isChild.has(id));
  const starting = roots.length > 0 ? roots : order;

  const nodes: SnapshotNode[] = [];
  const lines: string[] = [];
  let totalNodes = 0;
  let truncated = false;
  const visited = new Set<string>();

  const emit = (node: SnapshotNode, depth: number): void => {
    totalNodes += 1;
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    nodes.push(node);
    lines.push(renderLine(node, depth));
  };

  const visit = (axNodeId: string, depth: number): void => {
    if (visited.has(axNodeId) || depth > 100) {
      return;
    }
    visited.add(axNodeId);
    const raw = byId.get(axNodeId);
    if (raw === undefined) {
      return;
    }
    const children: string[] = Array.isArray(raw.childIds)
      ? (raw.childIds as unknown[]).filter(
          (child): child is string => typeof child === "string" && byId.has(child),
        )
      : [];
    if (raw.ignored === true) {
      for (const child of children) {
        visit(child, depth);
      }
      return;
    }
    const role = axString(raw.role).trim().toLowerCase();
    const name = truncateField(axString(raw.name).trim());
    const description = truncateField(axString(raw.description).trim());
    let value = truncateField(axString(raw.value).trim());
    const properties = raw.properties;
    const disabled = booleanProperty(properties, "disabled");
    const focused = booleanProperty(properties, "focused");
    const selected = booleanProperty(properties, "selected");
    const checked = checkedProperty(properties);
    const expanded = booleanProperty(properties, "expanded");
    const level = levelProperty(properties);

    const backendId = typeof raw.backendDOMNodeId === "number" ? raw.backendDOMNodeId : null;
    // Fail-closed value redaction: a value-bearing editable control keeps
    // its value ONLY when positively classified safe. Password semantics
    // (confirmed password input, password-like AX semantics, or the
    // credential-name defense-in-depth heuristic) always redact, and any
    // unknown/unprobed/failed state redacts as well.
    if (value !== "" && EDITABLE_VALUE_ROLES.has(role)) {
      const safety = backendId !== null ? options.valueSafety?.get(backendId) : undefined;
      const legacyPassword = backendId !== null && options.passwordBackendIds?.has(backendId) === true;
      const axPassword = axPasswordSemantics(raw);
      if (safety === "password" || legacyPassword || axPassword || PASSWORD_NAME_PATTERN.test(name)) {
        value = "";
      } else if (safety !== "safe") {
        value = "";
      }
    }

    const hasContent =
      name !== "" || value !== "" || description !== "" || disabled === true || focused === true || selected === true;
    if ((role === "" || WRAPPER_ROLES.has(role)) && !hasContent && checked === undefined && expanded === undefined) {
      for (const child of children) {
        visit(child, depth);
      }
      return;
    }
    const normalized: SnapshotNode = { role: displayRole(role === "" ? "group" : role) };
    if (ACTIONABLE_ROLES.has(role)) {
      const ref = options.allocateRef(axNodeId, role);
      if (ref !== null) {
        (normalized as { ref?: string }).ref = ref;
      }
    }
    if (name !== "") {
      (normalized as { name?: string }).name = name;
    }
    if (value !== "") {
      (normalized as { value?: string }).value = value;
    }
    if (description !== "") {
      (normalized as { description?: string }).description = description;
    }
    if (disabled === true) {
      (normalized as { disabled?: boolean }).disabled = true;
    }
    if (focused === true) {
      (normalized as { focused?: boolean }).focused = true;
    }
    if (selected === true) {
      (normalized as { selected?: boolean }).selected = true;
    }
    if (checked !== undefined) {
      (normalized as { checked?: boolean | "mixed" }).checked = checked;
    }
    if (expanded !== undefined) {
      (normalized as { expanded?: boolean }).expanded = expanded;
    }
    if (level !== undefined) {
      (normalized as { level?: number }).level = level;
    }
    emit(normalized, depth);
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  for (const root of starting) {
    visit(root, 0);
  }

  let text = lines.join("\n");
  if (text.length > SNAPSHOT_MAX_TEXT_CHARS) {
    text = text.slice(0, SNAPSHOT_MAX_TEXT_CHARS);
    truncated = true;
  }

  // Hard serialized-payload budget: measure the exact result envelope
  // (nodes + text + metadata) and keep only the largest fitting prefix.
  // Refs stay consistent because only trailing inclusion is removed;
  // published refs are allocated by the caller for surviving nodes only.
  // Binary search keeps the adversarial case (1500 max-length nodes) fast.
  const budget = options.maxSerializedBytes ?? SNAPSHOT_MAX_SERIALIZED_BYTES;
  const envelope = options.envelope;
  if (envelope !== undefined && budget > 0) {
    const measure = (candidateCount: number, candidateText: string): number =>
      utf8Length(
        JSON.stringify({
          snapshotId: envelope.snapshotId,
          tabId: envelope.tabId,
          url: envelope.url,
          title: envelope.title,
          nodes: nodes.slice(0, candidateCount),
          // Measure with the longer `false` literal so the bound holds
          // whether the final envelope reports truncated true or false.
          text: candidateText,
          truncated: false,
          totalNodes,
          includedNodes: candidateCount,
        }),
      );
    if (measure(nodes.length, text) > budget) {
      truncated = true;
      let low = 0;
      let high = nodes.length;
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        const probeText = lines.slice(0, mid).join("\n").slice(0, SNAPSHOT_MAX_TEXT_CHARS);
        if (measure(mid, probeText) <= budget) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      nodes.length = low;
      const rebuilt = lines.slice(0, low).join("\n");
      text = rebuilt.length > SNAPSHOT_MAX_TEXT_CHARS ? rebuilt.slice(0, SNAPSHOT_MAX_TEXT_CHARS) : rebuilt;
      if (nodes.length === 0) {
        text = "";
      }
      // Final guard: text shedding alone is bounded above, so if the
      // prefix still does not fit (pathological escaping), drop to empty.
      if (measure(nodes.length, text) > budget) {
        nodes.length = 0;
        text = "";
      }
    }
  }
  return { nodes, text, truncated, totalNodes, includedNodes: nodes.length };
}

function renderLine(node: SnapshotNode, depth: number): string {
  const indent = "  ".repeat(Math.min(depth, 8));
  const attrs: string[] = [];
  if (node.ref !== undefined) {
    attrs.push(`ref=${node.ref}`);
  }
  if (node.level !== undefined) {
    attrs.push(`level=${String(node.level)}`);
  }
  if (node.disabled === true) {
    attrs.push("disabled");
  }
  if (node.focused === true) {
    attrs.push("focused");
  }
  if (node.selected === true) {
    attrs.push("selected");
  }
  if (node.checked !== undefined) {
    attrs.push(`checked=${String(node.checked)}`);
  }
  if (node.expanded !== undefined) {
    attrs.push(`expanded=${String(node.expanded)}`);
  }
  if (node.value !== undefined && node.value !== "") {
    attrs.push(`value=${JSON.stringify(node.value)}`);
  }
  const head = attrs.length > 0 ? `[${node.role} ${attrs.join(" ")}]` : `[${node.role}]`;
  const label = node.name ?? (node.description ?? "");
  return `${indent}${head}${label === "" ? "" : ` ${label}`}`.slice(0, 600);
}

export function isElementRefSyntax(ref: string): boolean {
  return ELEMENT_REF_PATTERN.test(ref);
}

export function isSnapshotIdSyntax(snapshotId: string): boolean {
  return SNAPSHOT_ID_PATTERN.test(snapshotId);
}

/**
 * Walk a JSON-shaped value and report any raw CDP/Chrome internal id keys.
 * Used by unit tests and as defense-in-depth in the engine before MCP
 * output is returned.
 */
export function findLeakedCdpKeys(value: unknown): string[] {
  const leaked = new Set<string>();
  const seen: unknown[] = [];
  const walk = (current: unknown): void => {
    if (typeof current !== "object" || current === null || seen.includes(current)) {
      return;
    }
    seen.push(current);
    if (Array.isArray(current)) {
      for (const entry of current) {
        walk(entry);
      }
      return;
    }
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      if (LEAKED_CDP_KEYS.has(key)) {
        leaked.add(key);
      }
      walk(entry);
    }
  };
  walk(value);
  return [...leaked];
}
