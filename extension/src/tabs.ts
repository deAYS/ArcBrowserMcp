/**
 * Extension-side tab registry (DOM-free, no global chrome use).
 *
 * Public project IDs embed an opaque session epoch: `t-<epoch>-<chromeId>`
 * (plus `-r<n>` on same-epoch numeric reuse). The epoch is 128-bit
 * cryptographic randomness generated once per extension/browser session and
 * kept in chrome.storage.session:
 * - Worker suspension/restart restores the SAME epoch, so live tabs keep
 *   identical project IDs (stability requirement).
 * - Reload/update/browser restart clears session storage, so a NEW epoch is
 *   generated and every old project ID fails closed on epoch mismatch, even
 *   if Chrome reuses the same numeric tab ID (stale-ID safety requirement).
 * Within one epoch, closed/replaced numeric IDs become tombstones; a
 * resurrected numeric ID receives a suffixed identity while the old one
 * stays dead (rule B for replacements: fail, never retarget).
 *
 * Node receives project-owned records through RPC and never sees numeric
 * Chrome IDs.
 */

const EPOCH_STORAGE_KEY = "arcMcpTabEpoch";
const EPOCH_PATTERN = /^[0-9a-f]{32}$/;

export interface ChromeTabView {
  readonly id: number | undefined;
  readonly url: string | undefined;
  readonly pendingUrl?: string | undefined;
  readonly title: string | undefined;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly windowId: number;
  readonly index: number;
}
export interface ChromeTabReloadRecord {
  readonly tabId: number;
  readonly bypassCache: boolean | undefined;
}

export interface TabsChrome {
  query(info: Record<string, unknown>): Promise<ChromeTabView[]>;
  create(properties: { url?: string; active?: boolean }): Promise<ChromeTabView>;
  update(tabId: number, properties: { active?: boolean; url?: string }): Promise<ChromeTabView | undefined>;
  get(tabId: number): Promise<ChromeTabView>;
  remove(tabId: number): Promise<void>;
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;
  reload(tabId: number, bypassCache: boolean | undefined): Promise<void>;
  onCreated(listener: (tab: ChromeTabView) => void): void;
  onRemoved(listener: (tabId: number) => void): void;
  onUpdated(listener: (tabId: number, tab: ChromeTabView) => void): void;
  onReplaced(listener: (addedTabId: number, removedTabId: number) => void): void;
}

export interface TombstoneStore {
  loadRetired(): Promise<number[]>;
  saveRetired(retired: number[]): Promise<void>;
  loadCounters(): Promise<Record<string, number>>;
  saveCounters(counters: Record<string, number>): Promise<void>;
  loadEpoch(): Promise<string | null>;
  saveEpoch(epoch: string): Promise<void>;
}

export interface ProjectTabRecord {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly windowId: number;
  readonly controllable: boolean;
}

export type TabErrorCode =
  | "TAB_NOT_FOUND"
  | "TAB_INVALID_ID"
  | "TAB_CREATE_FAILED"
  | "TAB_CLOSE_FAILED"
  | "TAB_NOT_CONTROLLABLE"
  | "TAB_URL_NOT_ALLOWED"
  | "TAB_HISTORY_UNAVAILABLE"
  | "TAB_NAVIGATION_FAILED";

export class TabError extends Error {
  readonly code: TabErrorCode;

  constructor(code: TabErrorCode, message: string) {
    super(message);
    this.name = "TabError";
    this.code = code;
  }
}

const RETIRED_STORAGE_KEY = "arcMcpRetiredTabs";
const COUNTERS_STORAGE_KEY = "arcMcpTabReuseCounters";

/** In-memory tombstone store (tests, or fallback when session storage fails). */
export function createMemoryTombstoneStore(): TombstoneStore {
  let retired: number[] = [];
  let counters: Record<string, number> = {};
  let epoch: string | null = null;
  return {
    loadRetired: () => Promise.resolve([...retired]),
    saveRetired: (ids: number[]) => {
      retired = [...ids];
      return Promise.resolve();
    },
    loadCounters: () => Promise.resolve({ ...counters }),
    saveCounters: (next: Record<string, number>) => {
      counters = { ...next };
      return Promise.resolve();
    },
    loadEpoch: () => Promise.resolve(epoch),
    saveEpoch: (next: string) => {
      epoch = next;
      return Promise.resolve();
    },
  };
}

export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** chrome.storage.session-backed tombstones (suspension-safe, not permanent). */
export function createSessionTombstoneStore(area: SessionStorageArea): TombstoneStore {
  const readNumbers = async (key: string): Promise<number[]> => {
    const stored = await area.get(key);
    const value = stored[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry));
  };
  const readCounters = async (): Promise<Record<string, number>> => {
    const stored = await area.get(COUNTERS_STORAGE_KEY);
    const value = stored[COUNTERS_STORAGE_KEY];
    if (typeof value !== "object" || value === null) {
      return {};
    }
    const counters: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "number" && Number.isInteger(entry)) {
        counters[key] = entry;
      }
    }
    return counters;
  };
  return {
    loadRetired: () => readNumbers(RETIRED_STORAGE_KEY),
    saveRetired: (ids: number[]) => area.set({ [RETIRED_STORAGE_KEY]: ids }),
    loadCounters: readCounters,
    saveCounters: (counters: Record<string, number>) => area.set({ [COUNTERS_STORAGE_KEY]: counters }),
    loadEpoch: async () => {
      const stored = await area.get(EPOCH_STORAGE_KEY);
      const value = stored[EPOCH_STORAGE_KEY];
      return typeof value === "string" && EPOCH_PATTERN.test(value) ? value : null;
    },
    saveEpoch: (epoch: string) => area.set({ [EPOCH_STORAGE_KEY]: epoch }),
  };
}

/** Deterministic rule: normal web URLs are controllable, internal schemes are not. */
export function isControllableUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

function effectiveUrl(tab: ChromeTabView): string {
  // chrome.tabs.create returns before navigation commits: url is empty and
  // the target lives in pendingUrl. Prefer committed, fall back to pending
  // so records are accurate at creation instead of one query behind.
  if (tab.url !== undefined && tab.url !== "") {
    return tab.url;
  }
  return tab.pendingUrl ?? "";
}

function toRecord(projectId: string, tab: ChromeTabView): ProjectTabRecord {
  const url = effectiveUrl(tab);
  return {
    id: projectId,
    title: tab.title ?? "",
    url,
    active: tab.active,
    pinned: tab.pinned,
    windowId: tab.windowId,
    controllable: isControllableUrl(url),
  };
}

const PROJECT_ID_PATTERN = /^t-([0-9a-f]{32})-(\d+)(?:-r(\d+))?$/;

export function parseProjectId(projectId: string): { epoch: string; chromeId: number; suffix: number | null } | null {
  const match = PROJECT_ID_PATTERN.exec(projectId);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const chromeId = Number.parseInt(match[2], 10);
  if (!Number.isInteger(chromeId)) {
    return null;
  }
  const suffix = match[3] === undefined ? null : Number.parseInt(match[3], 10);
  if (match[3] !== undefined && !Number.isInteger(suffix)) {
    return null;
  }
  return { epoch: match[1], chromeId, suffix };
}

/** 128-bit session epoch from cryptographic randomness (never a secret). */
export function generateTabEpoch(randomValues?: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(16);
  if (randomValues !== undefined) {
    randomValues(bytes);
  } else {
    crypto.getRandomValues(bytes);
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface KnownTab {
  projectId: string;
  record: ProjectTabRecord;
}

export interface TabRegistryOptions {
  /** Deterministic epoch source for tests; defaults to crypto randomness. */
  readonly generateEpoch?: () => string;
}

export class TabRegistry {
  private readonly known = new Map<number, KnownTab>();
  private readonly retired = new Set<number>();
  private readonly reuseCounters = new Map<number, number>();
  private restored = false;
  private epoch: string | null = null;

  constructor(
    private readonly store: TombstoneStore = createMemoryTombstoneStore(),
    private readonly options: TabRegistryOptions = {},
  ) {}

  /** Best-effort restore of epoch/tombstones/counters; never throws. */
  async restoreRetired(): Promise<void> {
    if (this.restored) {
      return;
    }
    this.restored = true;
    try {
      const storedEpoch = await this.store.loadEpoch();
      if (storedEpoch !== null && EPOCH_PATTERN.test(storedEpoch)) {
        this.epoch = storedEpoch;
      }
      for (const id of await this.store.loadRetired()) {
        this.retired.add(id);
      }
      const counters = await this.store.loadCounters();
      for (const [key, value] of Object.entries(counters)) {
        const chromeId = Number.parseInt(key, 10);
        if (Number.isInteger(chromeId)) {
          this.reuseCounters.set(chromeId, value);
        }
      }
    } catch {
      // Memory fallback already in place; degraded safety documented.
    }
    if (this.epoch === null) {
      this.epoch = this.options.generateEpoch?.() ?? generateTabEpoch();
      try {
        await this.store.saveEpoch(this.epoch);
      } catch {
        // Ephemeral epoch still protects the current session.
      }
    }
  }

  /** Current epoch, initializing first (used by tests). */
  async currentEpoch(): Promise<string> {
    await this.restoreRetired();
    const epoch = this.epoch;
    if (epoch === null) {
      throw new Error("tab registry failed to initialize an epoch");
    }
    return epoch;
  }

  private persist(): void {
    // Fire-and-forget by design: persistence failure must never break ops.
    void this.store.saveRetired([...this.retired]).catch(() => undefined);
    const counters: Record<string, number> = {};
    for (const [key, value] of this.reuseCounters) {
      counters[String(key)] = value;
    }
    void this.store.saveCounters(counters).catch(() => undefined);
  }

  private retire(chromeId: number): void {
    this.known.delete(chromeId);
    this.retired.add(chromeId);
    this.persist();
  }

  private assignProjectId(chromeId: number): string {
    const epoch = this.epoch;
    if (epoch === null) {
      throw new Error("tab registry used before initialization");
    }
    const existing = this.known.get(chromeId);
    if (existing !== undefined) {
      return existing.projectId;
    }
    if (!this.retired.has(chromeId)) {
      return `t-${epoch}-${String(chromeId)}`;
    }
    // Numeric ID reuse detected: the old project ID stays dead; the
    // resurrected tab gets a stable suffixed identity.
    const next = (this.reuseCounters.get(chromeId) ?? 1) + 1;
    this.reuseCounters.set(chromeId, next);
    this.persist();
    return `t-${epoch}-${String(chromeId)}-r${String(next)}`;
  }

  private refresh(chromeId: number, tab: ChromeTabView): ProjectTabRecord {
    const projectId = this.assignProjectId(chromeId);
    const record = toRecord(projectId, tab);
    this.known.set(chromeId, { projectId, record });
    return record;
  }

  /** Full authoritative list; reconciles removals, replacements, and externals. */
  async list(chrome: TabsChrome): Promise<ProjectTabRecord[]> {
    await this.restoreRetired();
    const tabs = await chrome.query({});
    const live = new Set<number>();
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        live.add(tab.id);
      }
    }
    for (const chromeId of [...this.known.keys()]) {
      if (!live.has(chromeId)) {
        this.retire(chromeId);
      }
    }
    // Deterministic order: window grouping + tab index (query order kept).
    const records: ProjectTabRecord[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined) {
        continue;
      }
      records.push(this.refresh(tab.id, tab));
    }
    return records;
  }

  /** Resolve a project ID to its live numeric Chrome ID (reconciles first). */
  async resolve(chrome: TabsChrome, projectId: string): Promise<number> {
    const parsed = parseProjectId(projectId);
    if (parsed === null) {
      throw new TabError("TAB_INVALID_ID", `unknown tab reference ${JSON.stringify(projectId)}`);
    }
    await this.list(chrome);
    // Epoch gate first: an ID from any older session fails closed here and
    // must never fall through to a best-effort Chrome lookup.
    if (this.epoch === null || parsed.epoch !== this.epoch) {
      throw new TabError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectId)} no longer exists`);
    }
    const known = this.known.get(parsed.chromeId);
    if (known === undefined || known.projectId !== projectId) {
      throw new TabError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectId)} no longer exists`);
    }
    return parsed.chromeId;
  }

  async openTab(chrome: TabsChrome, url?: string): Promise<ProjectTabRecord> {
    if (url !== undefined && url !== "" && !/^(https?|about):/i.test(url)) {
      throw new TabError("TAB_CREATE_FAILED", `refusing to open forbidden scheme in ${JSON.stringify(url)}`);
    }
    let created: ChromeTabView;
    try {
      created = url === undefined || url === ""
        ? await chrome.create({ active: true })
        : await chrome.create({ url, active: true });
    } catch (error: unknown) {
      throw new TabError("TAB_CREATE_FAILED", `could not open tab: ${errorMessage(error)}`);
    }
    if (created.id === undefined) {
      throw new TabError("TAB_CREATE_FAILED", "browser returned no tab id for the opened tab");
    }
    await this.restoreRetired();
    return this.refresh(created.id, created);
  }

  async closeTab(chrome: TabsChrome, projectId: string): Promise<{ closed: string }> {
    const chromeId = await this.resolve(chrome, projectId);
    try {
      await chrome.remove(chromeId);
    } catch (error: unknown) {
      throw new TabError("TAB_CLOSE_FAILED", `could not close tab ${JSON.stringify(projectId)}: ${errorMessage(error)}`);
    }
    this.retire(chromeId);
    return { closed: projectId };
  }

  async activateTab(chrome: TabsChrome, projectId: string): Promise<ProjectTabRecord> {
    const chromeId = await this.resolve(chrome, projectId);
    let updated: ChromeTabView | undefined;
    try {
      updated = await chrome.update(chromeId, { active: true });
    } catch (error: unknown) {
      throw new TabError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectId)} no longer exists: ${errorMessage(error)}`);
    }
    if (updated === undefined || updated.id === undefined) {
      throw new TabError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectId)} no longer exists`);
    }
    return this.refresh(updated.id, updated);
  }

  /** Current record without extra Chrome round trips (call list() first). */
  currentRecord(chromeId: number): ProjectTabRecord | null {
    return this.known.get(chromeId)?.record ?? null;
  }
  /**
   * Navigate the project tab to a validated absolute URL. The caller has
   * already passed shared URL policy; the extension revalidates before
   * touching chrome.tabs. Returns accepted-request
   * metadata, NOT a load guarantee.
   */
  async navigateTab(
    chrome: TabsChrome,
    projectId: string,
    url: string,
    validate: (raw: string) => { ok: true; url: string } | { ok: false; failure: { reason: string } },
  ): Promise<ProjectTabRecord> {
    const chromeId = await this.resolve(chrome, projectId);
    const current = this.currentRecord(chromeId);
    // Empty/uncommitted ("" from a racing query) is treated as navigable:
    // resolve() already reconciled the tab as live by querying chrome (a
    // closed privileged tab would fail there instead). Only privileged
    // browser-UI schemes that are positively identified are refused here.
    if (current !== null && isPrivilegedSource(current.url)) {
      throw new TabError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectId)} is not a controllable web page and cannot be navigated`,
      );
    }
    const policy = validate(url);
    if (!policy.ok) {
      throw new TabError(
        "TAB_URL_NOT_ALLOWED",
        `refusing to navigate: ${policy.failure.reason} in ${JSON.stringify(url)}`,
      );
    }
    let updated: ChromeTabView | undefined;
    try {
      updated = await chrome.update(chromeId, { url: policy.url });
    } catch (error: unknown) {
      throw new TabError("TAB_NAVIGATION_FAILED", `could not navigate tab ${JSON.stringify(projectId)}: ${errorMessage(error)}`);
    }
    if (updated === undefined || updated.id === undefined) {
      throw new TabError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectId)} no longer exists`);
    }
    return this.refresh(updated.id, updated);
  }

  /** History back on the resolved project tab; no-history is a typed error. */
  async goBackTab(chrome: TabsChrome, projectId: string): Promise<ProjectTabRecord> {
    const chromeId = await this.resolve(chrome, projectId);
    this.requireControllable(projectId, chromeId);
    try {
      await chrome.goBack(chromeId);
    } catch (error: unknown) {
      throw mapHistoryError(projectId, "back", error);
    }
    return this.refreshAfterHistory(chrome, chromeId, projectId);
  }

  /** History forward on the resolved project tab; no-history is typed. */
  async goForwardTab(chrome: TabsChrome, projectId: string): Promise<ProjectTabRecord> {
    const chromeId = await this.resolve(chrome, projectId);
    this.requireControllable(projectId, chromeId);
    try {
      await chrome.goForward(chromeId);
    } catch (error: unknown) {
      throw mapHistoryError(projectId, "forward", error);
    }
    return this.refreshAfterHistory(chrome, chromeId, projectId);
  }

  /** Reload the resolved project tab; bypassCache maps from ignoreCache. */
  async reloadTab(chrome: TabsChrome, projectId: string, bypassCache: boolean): Promise<ProjectTabRecord> {
    const chromeId = await this.resolve(chrome, projectId);
    this.requireControllable(projectId, chromeId);
    try {
      await chrome.reload(chromeId, bypassCache);
    } catch (error: unknown) {
      throw new TabError("TAB_NAVIGATION_FAILED", `could not reload tab ${JSON.stringify(projectId)}: ${errorMessage(error)}`);
    }
    return this.refreshAfterHistory(chrome, chromeId, projectId);
  }

  private requireControllable(projectId: string, chromeId: number): ProjectTabRecord {
    const current = this.currentRecord(chromeId);
    if (current === null) {
      throw new TabError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectId)} is not a controllable web page`,
      );
    }
    if (isPrivilegedSource(current.url)) {
      throw new TabError(
        "TAB_NOT_CONTROLLABLE",
        `tab ${JSON.stringify(projectId)} is not a controllable web page`,
      );
    }
    return current;
  }

  /** Best-effort refreshed snapshot after history/reload commands. */
  private async refreshAfterHistory(
    chrome: TabsChrome,
    chromeId: number,
    projectId: string,
  ): Promise<ProjectTabRecord> {
    try {
      const tab = await chrome.get(chromeId);
      return this.refresh(chromeId, tab);
    } catch {
      throw new TabError("TAB_NOT_FOUND", `tab ${JSON.stringify(projectId)} no longer exists`);
    }
  }

  /** Synchronous listener registration for SW startup (eager tombstoning). */
  attachListeners(events: {
    onCreated(listener: (tab: ChromeTabView) => void): void;
    onRemoved(listener: (tabId: number) => void): void;
    onUpdated(listener: (tabId: number, tab: ChromeTabView) => void): void;
    onReplaced(listener: (addedTabId: number, removedTabId: number) => void): void;
  }): void {
    events.onCreated((tab) => {
      if (tab.id !== undefined) {
        void this.restoreRetired().then(() => {
          if (tab.id !== undefined) {
            this.refresh(tab.id, tab);
          }
        });
      }
    });
    events.onRemoved((tabId) => {
      this.retire(tabId);
    });
    events.onUpdated((tabId, tab) => {
      if (this.known.has(tabId)) {
        this.refresh(tabId, tab);
      }
    });
    events.onReplaced((addedTabId, removedTabId) => {
      // Rule B: the old project ID dies; the replacement maps fresh.
      this.retire(removedTabId);
      this.known.delete(addedTabId);
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Chrome-internal schemes the agent must never drive navigation into. */
function isPrivilegedSource(url: string): boolean {
  return /^(chrome|arc|chrome-extension|devtools|view-source|edge|about):/i.test(url) &&
    !/^about:blank$/i.test(url);
}

/**
 * Chrome history APIs silently no-op on some surfaces and reject on others.
 * Absence of a history entry and a genuinely missing tab look different:
 * resolution already proved the tab exists, so a rejection here maps to
 * history-unavailable rather than tab-not-found.
 */
function mapHistoryError(projectId: string, direction: "back" | "forward", error: unknown): TabError {
  return new TabError(
    "TAB_HISTORY_UNAVAILABLE",
    `no ${direction} history is available for tab ${JSON.stringify(projectId)}: ${errorMessage(error)}`,
  );
}
