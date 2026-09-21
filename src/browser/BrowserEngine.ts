import type {
  BrowserStatus,
  BrowserTab,
  ClickOptions,
  ClickTypeOptions,
  ConsoleClearResult,
  ConsoleResult,
  ElementRef,
  EvaluateOptions,
  EvaluateResult,
  NavigateRequest,
  NavigateResult,
  NetworkClearResult,
  NetworkResult,
  PressSequenceOptions,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotOptions,
  SnapshotResult,
  TabId,
  TypeHumanOptions,
  WaitCondition,
  WaitResult,
} from "./models.js";

/**
 * Backend-agnostic browser contract consumed by BrowserService.
 *
 * Method signatures use project-owned
 * request/result models so backends can be added without rewriting this
 * interface. Nothing here may reference Playwright, CDP, or any browser-specific API.
 */
export interface BrowserEngine {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): Promise<BrowserStatus>;
  listTabs(): Promise<BrowserTab[]>;
  selectTab(tabId: TabId): Promise<void>;
  openTab(url?: string): Promise<BrowserTab>;
  closeTab(tabId: TabId): Promise<void>;
  navigate(request: NavigateRequest): Promise<NavigateResult>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(ignoreCache?: boolean): Promise<void>;
  snapshot(options?: SnapshotOptions): Promise<SnapshotResult>;
  click(ref: ElementRef, options?: ClickOptions): Promise<void>;
  fill(ref: ElementRef, text: string): Promise<void>;
  type(ref: ElementRef, text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  typeHuman(ref: ElementRef, text: string, options?: TypeHumanOptions): Promise<void>;
  pressSequence(keys: string[], options?: PressSequenceOptions): Promise<void>;
  clickType(ref: ElementRef, text: string, options?: ClickTypeOptions): Promise<void>;
  getText(ref?: ElementRef): Promise<string>;
  evaluate(expression: string, options?: EvaluateOptions): Promise<EvaluateResult>;
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
  waitFor(condition: WaitCondition): Promise<WaitResult>;
  getConsole(limit?: number): Promise<ConsoleResult>;
  clearConsole(): Promise<ConsoleClearResult>;
  getNetwork(limit?: number): Promise<NetworkResult>;
  clearNetwork(): Promise<NetworkClearResult>;
}
