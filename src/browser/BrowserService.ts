import type { BrowserEngine } from "./BrowserEngine.js";
import type {
  BrowserStatus,
  BrowserTab,
  ClickTypeOptions,
  ConsoleClearResult,
  ConsoleResult,
  EvaluateOptions,
  EvaluateResult,
  NavigateResult,
  NetworkClearResult,
  NetworkResult,
  PressSequenceOptions,
  ScreenshotResult,
  SnapshotOptions,
  SnapshotResult,
  TypeHumanOptions,
  WaitCondition,
  WaitResult,
} from "./models.js";
import { browserOperationNotImplemented, browserTabNotFound } from "../errors/BrowserError.js";

/**
 * Browser control state orchestration.
 *
 * The MCP layer depends only on this service, never on Playwright,
 * ArcLauncher, CDP, child processes, bridge RPC, or chrome.*: MCP tool ->
 * BrowserService -> BrowserEngine. Without an engine status
 * reports the long-standing disconnected placeholder, and tab operations
 * report not-implemented rather than failing obscurely.
 */
export class BrowserService {
  constructor(private readonly engine?: BrowserEngine) {}

  async getStatus(): Promise<BrowserStatus> {
    if (this.engine === undefined) {
      return {
        connected: false,
        state: "disconnected",
        backend: "none",
        profileMode: "dedicated-mcp-profile",
        selectedTabId: null,
        reason: "browser-engine-not-implemented",
      };
    }
    return this.engine.status();
  }

  private requireEngine(operation: string): BrowserEngine {
    if (this.engine === undefined) {
      throw browserOperationNotImplemented(operation);
    }
    return this.engine;
  }

  async listTabs(): Promise<{ tabs: BrowserTab[]; selectedTabId: string | null }> {
    const engine = this.requireEngine("listTabs");
    const tabs = await engine.listTabs();
    const status = await engine.status();
    return { tabs, selectedTabId: status.selectedTabId };
  }

  async selectTab(tabId: string): Promise<{ tab: BrowserTab; selectedTabId: string | null }> {
    const engine = this.requireEngine("selectTab");
    await engine.selectTab(tabId);
    const tabs = await engine.listTabs();
    const tab = tabs.find((entry) => entry.id === tabId);
    if (tab === undefined) {
      throw browserTabNotFound(tabId);
    }
    const status = await engine.status();
    return { tab, selectedTabId: status.selectedTabId };
  }

  async openTab(url?: string): Promise<{ tab: BrowserTab; selectedTabId: string | null }> {
    const engine = this.requireEngine("openTab");
    const tab = url === undefined ? await engine.openTab() : await engine.openTab(url);
    const status = await engine.status();
    return { tab, selectedTabId: status.selectedTabId };
  }

  async closeTab(tabId: string): Promise<{ closedTabId: string; selectedTabId: string | null }> {
    const engine = this.requireEngine("closeTab");
    await engine.closeTab(tabId);
    const status = await engine.status();
    return { closedTabId: tabId, selectedTabId: status.selectedTabId };
  }

  async navigate(url: string): Promise<NavigateResult> {
    const engine = this.requireEngine("navigate");
    return engine.navigate({ url });
  }

  async goBack(): Promise<NavigateResult> {
    const engine = this.requireEngine("goBack");
    const before = await engine.status();
    await engine.goBack();
    return this.navigationSnapshot("back", before.selectedTabId, engine);
  }

  async goForward(): Promise<NavigateResult> {
    const engine = this.requireEngine("goForward");
    const before = await engine.status();
    await engine.goForward();
    return this.navigationSnapshot("forward", before.selectedTabId, engine);
  }

  async reload(ignoreCache?: boolean): Promise<NavigateResult> {
    const engine = this.requireEngine("reload");
    const before = await engine.status();
    if (ignoreCache === true) {
      await (engine as { reload(ignoreCache: boolean): Promise<void> }).reload(true);
    } else {
      await engine.reload();
    }
    return this.navigationSnapshot("reload", before.selectedTabId, engine);
  }

  /** Semantic Accessibility snapshot of the selected tab (read-only). */
  async snapshot(options?: SnapshotOptions): Promise<SnapshotResult> {
    const engine = this.requireEngine("snapshot");
    return options === undefined ? engine.snapshot() : engine.snapshot(options);
  }

  /** Click a live snapshot ref on the selected tab (invalidates refs). */
  async click(ref: string): Promise<{ accepted: true }> {
    const engine = this.requireEngine("click");
    await engine.click(ref);
    return { accepted: true };
  }

  /** Replace an editable control's text (invalidates refs). */
  async fill(ref: string, text: string): Promise<{ accepted: true }> {
    const engine = this.requireEngine("fill");
    await engine.fill(ref, text);
    return { accepted: true };
  }

  /** Insert text at the caret without clearing (invalidates refs). */
  async type(ref: string, text: string): Promise<{ accepted: true }> {
    const engine = this.requireEngine("type");
    await engine.type(ref, text);
    return { accepted: true };
  }

  /** Dispatch a supported key/chord to the selected tab. */
  async pressKey(key: string): Promise<{ accepted: true }> {
    const engine = this.requireEngine("pressKey");
    await engine.pressKey(key);
    return { accepted: true };
  }

  /** Humanized typing: chunked insert with WPM pacing (invalidates refs). */
  async typeHuman(ref: string, text: string, options?: TypeHumanOptions): Promise<{ accepted: true }> {
    const engine = this.requireEngine("typeHuman");
    await engine.typeHuman(ref, text, options);
    return { accepted: true };
  }

  /** Press a sequence of keys with inter-key delay (invalidates refs). */
  async pressSequence(keys: string[], options?: PressSequenceOptions): Promise<{ accepted: true }> {
    const engine = this.requireEngine("pressSequence");
    await engine.pressSequence(keys, options);
    return { accepted: true };
  }

  /** Click then type (optionally humanized + submit key) in one call. */
  async clickType(ref: string, text: string, options?: ClickTypeOptions): Promise<{ accepted: true }> {
    const engine = this.requireEngine("clickType");
    await engine.clickType(ref, text, options);
    return { accepted: true };
  }

  /** Fresh semantic read of a live ref (read-only, keeps refs). */
  async getText(ref: string): Promise<{ text: string }> {
    const engine = this.requireEngine("getText");
    return { text: await engine.getText(ref) };
  }

  /** Evaluate page JS in the selected tab (dispatched evaluate invalidates refs). */
  async evaluate(expression: string, options?: EvaluateOptions): Promise<EvaluateResult> {
    const engine = this.requireEngine("evaluate");
    return options === undefined ? engine.evaluate(expression) : engine.evaluate(expression, options);
  }

  /** Viewport-only PNG screenshot of the selected tab (read-only). */
  async screenshot(): Promise<ScreenshotResult> {
    const engine = this.requireEngine("screenshot");
    return engine.screenshot();
  }

  /** Bounded semantic wait on the selected tab (read-only). */
  async waitFor(condition: WaitCondition): Promise<WaitResult> {
    const engine = this.requireEngine("waitFor");
    return engine.waitFor(condition);
  }

  /** Bounded console entries for the selected tab (read-only). */
  async getConsole(limit?: number): Promise<ConsoleResult> {
    const engine = this.requireEngine("getConsole");
    return limit === undefined ? engine.getConsole() : engine.getConsole(limit);
  }

  /** Clear the selected tab's console buffer (read-only page-wise). */
  async clearConsole(): Promise<ConsoleClearResult> {
    const engine = this.requireEngine("clearConsole");
    return engine.clearConsole();
  }

  /** Bounded network metadata for the selected tab (read-only). */
  async getNetwork(limit?: number): Promise<NetworkResult> {
    const engine = this.requireEngine("getNetwork");
    return limit === undefined ? engine.getNetwork() : engine.getNetwork(limit);
  }

  /** Clear the selected tab's network buffer (read-only page-wise). */
  async clearNetwork(): Promise<NetworkClearResult> {
    const engine = this.requireEngine("clearNetwork");
    return engine.clearNetwork();
  }

  /** Post-history snapshot from browser truth; selection never changes here. */
  private async navigationSnapshot(
    action: "back" | "forward" | "reload",
    selectedTabId: string | null,
    engine: BrowserEngine,
  ): Promise<NavigateResult> {
    const tabs = await engine.listTabs();
    const tab = selectedTabId === null ? undefined : tabs.find((entry) => entry.id === selectedTabId);
    if (tab === undefined) {
      throw browserTabNotFound(selectedTabId ?? "(unknown)");
    }
    return { action, accepted: true, tab };
  }
}
