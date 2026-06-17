// START_MODULE_CONTRACT
// PURPOSE: Minimal stub of the `obsidian` runtime module for Vitest unit tests.
// SCOPE: src/__mocks__/obsidian.ts
// DEPENDS: none
// LINKS: V-M-PLATFORM, V-M-I18N, V-M-HTTP-BASE, V-M-HTTP-LOGS-BASE, V-M-VAULT-FILE-STORAGE, V-M-VAULT-WRITER, V-M-AUTH-UI, V-M-SETTINGS-UI, V-M-SUPPORT-UI
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// Platform - mutable mock of Obsidian's static Platform helper (isMobile, isDesktop, ...)
// moment - tiny stub exposing locale() used by M-I18N.detectDefaultLanguage
// requestUrl - controllable mock of obsidian.requestUrl Promise-based HTTP client
// MockDataAdapter - in-memory DataAdapter for vault-file-storage tests (Phase 2B)
// __setRequestUrlImpl - test helper to inject per-test requestUrl behavior
// __getRequestUrlCalls - test helper to inspect captured invocations
// __resetObsidianMock - test helper to restore default values between test cases
// App - minimal App stub used by PluginSettingTab / Modal / Plugin
// Plugin - minimal Plugin base class (saveData/loadData/addCommand/addRibbonIcon/addSettingTab)
// PluginSettingTab - base class for settings tabs (containerEl, display, hide)
// Modal - base class for modals (contentEl, open, close, onOpen, onClose)
// Notice - lightweight Notice stub recording message + duration
// Setting - chainable builder mirroring obsidian.Setting for unit tests
// __getNotices - test helper returning captured Notice instances
// __resetUiMocks - test helper restoring the UI stubs between cases
// END_MODULE_MAP

import { vi } from "vitest";

// START_BLOCK_PLATFORM_STUB
/**
 * Mock of `obsidian`'s Platform helper. Tests mutate fields directly:
 *
 *   import { Platform } from "obsidian";
 *   Platform.isMobile = true;
 */
export const Platform = {
  isMobile: false,
  isMobileApp: false,
  isDesktop: true,
  isDesktopApp: true,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: false,
  isWin: false,
  isLinux: false,
};
// END_BLOCK_PLATFORM_STUB

// START_BLOCK_MOMENT_STUB
let _locale = "en";
export const apiVersion = "0.15.0";

export const moment = {
  locale(next?: string): string {
    if (typeof next === "string" && next.length > 0) {
      _locale = next;
    }
    return _locale;
  },
};
// END_BLOCK_MOMENT_STUB

// START_BLOCK_REQUESTURL_STUB
/**
 * Shape mirrored from the real `obsidian` runtime types so tests can construct
 * synthetic responses without dragging in the full plugin API.
 */
export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
  json: unknown;
}

type RequestUrlImpl = (
  request: RequestUrlParam | string,
) => Promise<RequestUrlResponse>;

const _capturedCalls: Array<RequestUrlParam | string> = [];

/** Default implementation — returns 200 with empty body. Overridable per-test. */
let _requestUrlImpl: RequestUrlImpl = async (_request) => ({
  status: 200,
  headers: {},
  arrayBuffer: new ArrayBuffer(0),
  text: "",
  json: null,
});

export const requestUrl = vi.fn(
  (request: RequestUrlParam | string): Promise<RequestUrlResponse> => {
    _capturedCalls.push(request);
    return _requestUrlImpl(request);
  },
);

/** Tests call this to control what requestUrl returns / throws. */
export function __setRequestUrlImpl(impl: RequestUrlImpl): void {
  _requestUrlImpl = impl;
}

/** Inspect captured invocations (mirrors `requestUrl.mock.calls` but typed). */
export function __getRequestUrlCalls(): Array<RequestUrlParam | string> {
  return _capturedCalls.slice();
}
// END_BLOCK_REQUESTURL_STUB

// START_BLOCK_DATA_ADAPTER_MOCK
/**
 * In-memory DataAdapter used by M-VAULT-FILE-STORAGE / M-VAULT-WRITER tests.
 * Stores entries as either utf-8 strings (write) or ArrayBuffer (writeBinary).
 * `mtime` advances monotonically on each write, simulating filesystem timestamps.
 */
interface MockEntry {
  kind: "file" | "folder";
  content: string | ArrayBuffer;
  mtime: number;
  ctime: number;
  size: number;
}

export class MockDataAdapter {
  private store = new Map<string, MockEntry>();
  private clock = 1_000_000;

  getName(): string {
    return "mock";
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }

  async stat(
    path: string,
  ): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    const entry = this.store.get(path);
    if (!entry) return null;
    return {
      type: entry.kind,
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.size,
    };
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path.endsWith("/") || path.length === 0 ? path : `${path}/`;
    const files: string[] = [];
    const folders: string[] = [];
    for (const [key, entry] of this.store.entries()) {
      if (!key.startsWith(prefix) || key === path) continue;
      const remainder = key.slice(prefix.length);
      if (remainder.includes("/")) continue; // non-recursive
      // Return relative names, matching real Obsidian DataAdapter.list().
      if (entry.kind === "folder") folders.push(remainder);
      else files.push(remainder);
    }
    return { files, folders };
  }

  async read(path: string): Promise<string> {
    const entry = this.store.get(path);
    if (!entry || entry.kind !== "file") {
      throw new Error(`ENOENT: ${path}`);
    }
    if (typeof entry.content === "string") return entry.content;
    return new TextDecoder().decode(entry.content);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const entry = this.store.get(path);
    if (!entry || entry.kind !== "file") {
      throw new Error(`ENOENT: ${path}`);
    }
    if (entry.content instanceof ArrayBuffer) return entry.content;
    return new TextEncoder().encode(entry.content).buffer as ArrayBuffer;
  }

  async write(path: string, data: string): Promise<void> {
    this.clock += 1;
    this.store.set(path, {
      kind: "file",
      content: data,
      ctime: this.store.get(path)?.ctime ?? this.clock,
      mtime: this.clock,
      size: data.length,
    });
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.clock += 1;
    this.store.set(path, {
      kind: "file",
      content: data,
      ctime: this.store.get(path)?.ctime ?? this.clock,
      mtime: this.clock,
      size: data.byteLength,
    });
  }

  async remove(path: string): Promise<void> {
    if (!this.store.has(path)) {
      throw new Error(`ENOENT: ${path}`);
    }
    this.store.delete(path);
  }

  async mkdir(path: string): Promise<void> {
    if (this.store.has(path)) return;
    this.clock += 1;
    this.store.set(path, {
      kind: "folder",
      content: "",
      ctime: this.clock,
      mtime: this.clock,
      size: 0,
    });
  }

  /** Force a specific mtime on a path — used to simulate user edits in tests. */
  __setMtime(path: string, mtime: number): void {
    const entry = this.store.get(path);
    if (entry) entry.mtime = mtime;
  }

  __snapshot(): Record<string, MockEntry> {
    return Object.fromEntries(this.store.entries());
  }
}
// END_BLOCK_DATA_ADAPTER_MOCK

// START_CONTRACT: __resetObsidianMock
// PURPOSE: restore default values for Platform/moment between tests
// INPUTS: none
// OUTPUTS: void
// SIDE_EFFECTS: mutates Platform.* and moment locale
// LINKS: V-M-PLATFORM, V-M-I18N
// END_CONTRACT: __resetObsidianMock
export function __resetObsidianMock(): void {
  Platform.isMobile = false;
  Platform.isMobileApp = false;
  Platform.isDesktop = true;
  Platform.isDesktopApp = true;
  Platform.isIosApp = false;
  Platform.isAndroidApp = false;
  Platform.isPhone = false;
  Platform.isTablet = false;
  Platform.isMacOS = false;
  Platform.isWin = false;
  Platform.isLinux = false;
  _locale = "en";
  _capturedCalls.length = 0;
  _requestUrlImpl = async (_request) => ({
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    text: "",
    json: null,
  });
  requestUrl.mockClear();
  __resetUiMocks();
}

// START_BLOCK_UI_STUBS
/**
 * Minimal `App` stub used by Modal / Plugin / PluginSettingTab tests. The real
 * App exposes vault/workspace/metadataCache — we provide empty objects so tests
 * can satisfy the structural shape without dragging real Obsidian internals in.
 */
export class TFolder {
  path: string;
  children: unknown[];
  name: string;
  parent: TFolder | null;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    this.children = [];
    this.parent = null;
  }

  isRoot(): boolean {
    return this.path === "/";
  }
}

/**
 * Minimal stub of `AbstractInputSuggest<T>`. Real Obsidian opens a suggestion
 * popover bound to the text input. Here we just store the input element so
 * that VaultFolderSuggest can construct without crashing.
 */
export class AbstractInputSuggest<T> {
  protected inputEl: HTMLInputElement;
  limit = 100;

  constructor(_app: App, textInputEl: HTMLInputElement) {
    this.inputEl = textInputEl;
  }

  setValue(value: string): void {
    this.inputEl.value = value;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  close(): void {
    // no-op
  }
}

export class App {
  vault: {
    adapter: Record<string, unknown>;
    getAllFolders?: () => TFolder[];
  };
  workspace: Record<string, unknown> = {};
  metadataCache: Record<string, unknown> = {};

  constructor() {
    this.vault = {
      adapter: {},
      getAllFolders: () => [],
    };
  }
}

/**
 * Minimal Plugin base. Tests typically construct a Plugin and pass it where
 * the production code expects the real `Plugin` instance. saveData/loadData
 * are in-memory; addCommand / addRibbonIcon / addSettingTab record calls so
 * Phase 8 tests can assert wiring.
 */
export class Plugin {
  app: App;
  manifest: Record<string, unknown> = { id: "test-plugin", version: "0.0.0-test" };
  private _data: object | null = null;
  public readonly _commands: Array<Record<string, unknown>> = [];
  public readonly _ribbons: Array<{ icon: string; title: string; callback: () => void }> = [];
  public readonly _settingTabs: PluginSettingTab[] = [];

  constructor(app?: App) {
    this.app = app ?? new App();
  }

  async saveData(data: object): Promise<void> {
    this._data = data;
  }

  async loadData(): Promise<object | null> {
    return this._data;
  }

  addCommand(cmd: Record<string, unknown>): Record<string, unknown> {
    this._commands.push(cmd);
    return cmd;
  }

  addRibbonIcon(icon: string, title: string, callback: () => void): HTMLElement {
    this._ribbons.push({ icon, title, callback });
    // Return a stub element so callers expecting an HTMLElement get one.
    return _ensureDocument().createElement("div");
  }

  addSettingTab(tab: PluginSettingTab): void {
    this._settingTabs.push(tab);
  }
}

/**
 * Base class for Settings Tabs. Real Obsidian sets containerEl on the parent
 * class — we mimic that. `display()` / `hide()` are no-ops to be overridden.
 */
export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = _ensureDocument().createElement("div");
  }

  display(): void {
    // override in subclass
  }

  hide(): void {
    // override in subclass
  }
}

/**
 * Modal base. `contentEl` is the working element; production code mutates it
 * inside `onOpen()`. `open()` invokes `onOpen()`; `close()` invokes `onClose()`.
 */
export class Modal {
  app: App;
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  modalEl: HTMLElement;

  constructor(app: App) {
    this.app = app;
    const doc = _ensureDocument();
    this.modalEl = doc.createElement("div");
    this.titleEl = doc.createElement("div");
    this.contentEl = doc.createElement("div");
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
  }

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void {
    // override
  }

  onClose(): void {
    // override
  }

  setTitle(text: string): this {
    this.titleEl.textContent = text;
    return this;
  }
}

/**
 * Notice stub. Real obsidian.Notice pops up a toast — we just capture so tests
 * can assert. Test-only inspector exported as __getNotices.
 */
const _notices: Notice[] = [];

export class Notice {
  message: string;
  duration: number | undefined;
  constructor(message: string, duration?: number) {
    this.message = message;
    this.duration = duration;
    _notices.push(this);
  }
  hide(): void {
    // no-op in tests
  }
}

export function __getNotices(): Notice[] {
  return _notices.slice();
}

/**
 * Settings widget builder. Mirrors the chainable shape of obsidian.Setting just
 * deeply enough for unit tests:
 *
 *   new Setting(container)
 *     .setName('Output format')
 *     .setDesc('...')
 *     .addDropdown(d => d.addOption('a','A').setValue('a').onChange(...))
 *
 * Tests can inspect `.dropdowns`, `.toggles`, `.textInputs`, `.buttons` to
 * trigger user actions programmatically.
 */
export interface DropdownComponent {
  selectEl: HTMLSelectElement;
  addOption(value: string, display: string): DropdownComponent;
  setValue(value: string): DropdownComponent;
  getValue(): string;
  onChange(cb: (value: string) => void): DropdownComponent;
  setDisabled(d: boolean): DropdownComponent;
}

export interface ToggleComponent {
  toggleEl: HTMLInputElement;
  setValue(value: boolean): ToggleComponent;
  getValue(): boolean;
  onChange(cb: (value: boolean) => void): ToggleComponent;
  setDisabled(d: boolean): ToggleComponent;
}

export interface TextComponent {
  inputEl: HTMLInputElement;
  setPlaceholder(text: string): TextComponent;
  setValue(value: string): TextComponent;
  getValue(): string;
  onChange(cb: (value: string) => void): TextComponent;
  setDisabled(d: boolean): TextComponent;
}

export interface TextAreaComponent {
  inputEl: HTMLTextAreaElement;
  setPlaceholder(text: string): TextAreaComponent;
  setValue(value: string): TextAreaComponent;
  getValue(): string;
  onChange(cb: (value: string) => void): TextAreaComponent;
  setDisabled(d: boolean): TextAreaComponent;
}

export interface ButtonComponent {
  buttonEl: HTMLButtonElement;
  setButtonText(text: string): ButtonComponent;
  setCta(): ButtonComponent;
  setWarning(): ButtonComponent;
  onClick(cb: () => void): ButtonComponent;
  setDisabled(d: boolean): ButtonComponent;
}

function _makeDropdown(parent: HTMLElement): DropdownComponent {
  const select = _ensureDocument().createElement("select");
  parent.appendChild(select);
  let cb: ((v: string) => void) | null = null;
  const api: DropdownComponent = {
    selectEl: select,
    addOption(value, display) {
      const opt = _ensureDocument().createElement("option");
      opt.value = value;
      opt.textContent = display;
      select.appendChild(opt);
      return api;
    },
    setValue(value) {
      select.value = value;
      return api;
    },
    getValue() {
      return select.value;
    },
    onChange(callback) {
      cb = callback;
      select.addEventListener("change", () => cb?.(select.value));
      return api;
    },
    setDisabled(d) {
      select.disabled = d;
      return api;
    },
  };
  return api;
}

function _makeToggle(parent: HTMLElement): ToggleComponent {
  const input = _ensureDocument().createElement("input");
  input.type = "checkbox";
  parent.appendChild(input);
  let cb: ((v: boolean) => void) | null = null;
  const api: ToggleComponent = {
    toggleEl: input,
    setValue(value) {
      input.checked = value;
      return api;
    },
    getValue() {
      return input.checked;
    },
    onChange(callback) {
      cb = callback;
      input.addEventListener("change", () => cb?.(input.checked));
      return api;
    },
    setDisabled(d) {
      input.disabled = d;
      return api;
    },
  };
  return api;
}

function _makeText(parent: HTMLElement): TextComponent {
  const input = _ensureDocument().createElement("input");
  input.type = "text";
  parent.appendChild(input);
  let cb: ((v: string) => void) | null = null;
  const api: TextComponent = {
    inputEl: input,
    setPlaceholder(text) {
      input.placeholder = text;
      return api;
    },
    setValue(value) {
      input.value = value;
      return api;
    },
    getValue() {
      return input.value;
    },
    onChange(callback) {
      cb = callback;
      input.addEventListener("input", () => cb?.(input.value));
      return api;
    },
    setDisabled(d) {
      input.disabled = d;
      return api;
    },
  };
  return api;
}

function _makeTextArea(parent: HTMLElement): TextAreaComponent {
  const input = _ensureDocument().createElement("textarea");
  parent.appendChild(input);
  let cb: ((v: string) => void) | null = null;
  const api: TextAreaComponent = {
    inputEl: input,
    setPlaceholder(text) {
      input.placeholder = text;
      return api;
    },
    setValue(value) {
      input.value = value;
      return api;
    },
    getValue() {
      return input.value;
    },
    onChange(callback) {
      cb = callback;
      input.addEventListener("input", () => cb?.(input.value));
      return api;
    },
    setDisabled(d) {
      input.disabled = d;
      return api;
    },
  };
  return api;
}

function _makeButton(parent: HTMLElement): ButtonComponent {
  const btn = _ensureDocument().createElement("button");
  parent.appendChild(btn);
  let cb: (() => void) | null = null;
  const api: ButtonComponent = {
    buttonEl: btn,
    setButtonText(text) {
      btn.textContent = text;
      return api;
    },
    setCta() {
      btn.classList.add("mod-cta");
      return api;
    },
    setWarning() {
      btn.classList.add("mod-warning");
      return api;
    },
    onClick(callback) {
      cb = callback;
      btn.addEventListener("click", () => cb?.());
      return api;
    },
    setDisabled(d) {
      btn.disabled = d;
      return api;
    },
  };
  return api;
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  public readonly dropdowns: DropdownComponent[] = [];
  public readonly toggles: ToggleComponent[] = [];
  public readonly textInputs: TextComponent[] = [];
  public readonly textAreas: TextAreaComponent[] = [];
  public readonly buttons: ButtonComponent[] = [];

  constructor(parent: HTMLElement) {
    const doc = _ensureDocument();
    this.settingEl = doc.createElement("div");
    this.settingEl.classList.add("setting-item");
    this.infoEl = doc.createElement("div");
    this.infoEl.classList.add("setting-item-info");
    this.nameEl = doc.createElement("div");
    this.nameEl.classList.add("setting-item-name");
    this.descEl = doc.createElement("div");
    this.descEl.classList.add("setting-item-description");
    this.controlEl = doc.createElement("div");
    this.controlEl.classList.add("setting-item-control");
    this.infoEl.appendChild(this.nameEl);
    this.infoEl.appendChild(this.descEl);
    this.settingEl.appendChild(this.infoEl);
    this.settingEl.appendChild(this.controlEl);
    parent.appendChild(this.settingEl);
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }

  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }

  addDropdown(build: (d: DropdownComponent) => DropdownComponent | void): this {
    const d = _makeDropdown(this.controlEl);
    this.dropdowns.push(d);
    build(d);
    return this;
  }

  addToggle(build: (t: ToggleComponent) => ToggleComponent | void): this {
    const t = _makeToggle(this.controlEl);
    this.toggles.push(t);
    build(t);
    return this;
  }

  addText(build: (t: TextComponent) => TextComponent | void): this {
    const t = _makeText(this.controlEl);
    this.textInputs.push(t);
    build(t);
    return this;
  }

  addTextArea(build: (t: TextAreaComponent) => TextAreaComponent | void): this {
    const t = _makeTextArea(this.controlEl);
    this.textAreas.push(t);
    build(t);
    return this;
  }

  addButton(build: (b: ButtonComponent) => ButtonComponent | void): this {
    const b = _makeButton(this.controlEl);
    this.buttons.push(b);
    build(b);
    return this;
  }

  addExtraButton(build: (b: ButtonComponent) => ButtonComponent | void): this {
    return this.addButton(build);
  }
}

/**
 * Cross-environment document accessor. When tests run with environment=node,
 * `document` is undefined; the UI modules use a tiny in-memory DOM helper. We
 * detect that and lazily install a minimal DOM polyfill, just enough for tests
 * that build small subtrees, append children, dispatch events, and access
 * properties like `.classList`, `.textContent`, `.value`, `.checked`.
 *
 * Strategy: if happy-dom / jsdom is present in the environment, use the real
 * `document`. Otherwise, we install a minimal shim. This keeps the package
 * footprint zero while letting tests run in plain `node` environment.
 */
function _ensureDocument(): Document {
  if (typeof document !== "undefined") return document;
  // Install a minimal shim onto globalThis on first call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__readineMockDocument) return g.__readineMockDocument as Document;
  g.__readineMockDocument = _installMockDocument();
  return g.__readineMockDocument as Document;
}

interface MockListener {
  type: string;
  fn: (event: { target: unknown; type: string; preventDefault?: () => void }) => void;
}

class MockClassList {
  private set = new Set<string>();
  add(...names: string[]): void {
    for (const n of names) this.set.add(n);
  }
  remove(...names: string[]): void {
    for (const n of names) this.set.delete(n);
  }
  contains(name: string): boolean {
    return this.set.has(name);
  }
  toggle(name: string): boolean {
    if (this.set.has(name)) {
      this.set.delete(name);
      return false;
    }
    this.set.add(name);
    return true;
  }
}

class MockElement {
  tagName: string;
  children: MockElement[] = [];
  parentNode: MockElement | null = null;
  classList = new MockClassList();
  style: Record<string, string> = {};

  setCssStyles(styles: Record<string, string>): void {
    Object.assign(this.style, styles);
  }

  setCssProps(props: Record<string, string>): void {
    Object.assign(this.style, props);
  }

  private _attrs: Record<string, string> = {};

  private _listeners: MockListener[] = [];
  textContent = "";
  // type-specific fields
  value = "";
  checked = false;
  type = "";
  placeholder = "";
  disabled = false;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: MockElement): MockElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement): MockElement {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  /** Obsidian convenience — empty all children. */
  empty(): void {
    this.children.length = 0;
    this.textContent = "";
  }

  /** Obsidian convenience — create + append child. */
  createEl<K extends string>(
    tag: K,
    attrs?: { text?: string; cls?: string; href?: string },
  ): MockElement {
    const el = new MockElement(tag);
    if (attrs?.text) el.textContent = attrs.text;
    if (attrs?.cls) el.classList.add(...attrs.cls.split(/\s+/));
    if (attrs?.href) el.setAttribute("href", attrs.href);
    this.appendChild(el);
    return el;
  }

  /** Obsidian convenience — create+append a sub-div. */
  createDiv(attrs?: { cls?: string; text?: string }): MockElement {
    return this.createEl("div", attrs);
  }

  setAttribute(name: string, value: string): void {
    this._attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this._attrs, name)
      ? this._attrs[name] ?? null
      : null;
  }

  addEventListener(
    type: string,
    fn: (event: { target: unknown; type: string; preventDefault?: () => void }) => void,
  ): void {
    this._listeners.push({ type, fn });
  }

  dispatchEvent(event: { type: string; target?: unknown }): boolean {
    const e = { target: event.target ?? this, type: event.type, preventDefault: () => {} };
    for (const l of this._listeners) {
      if (l.type === event.type) {
        try {
          l.fn(e);
        } catch {
          // swallow — DOM event handlers may throw and we don't want one bad
          // listener to abort the dispatch loop.
        }
      }
    }
    return true;
  }

  // querySelector — not exhaustively implemented; we only need it for tag/class.
  querySelector(selector: string): MockElement | null {
    const found = this._find((el) => _matches(el, selector));
    return found ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const out: MockElement[] = [];
    this._walk((el) => {
      if (_matches(el, selector)) out.push(el);
    });
    return out;
  }

  private _find(predicate: (el: MockElement) => boolean): MockElement | null {
    for (const c of this.children) {
      if (predicate(c)) return c;
      const sub = c._find(predicate);
      if (sub) return sub;
    }
    return null;
  }

  private _walk(fn: (el: MockElement) => void): void {
    for (const c of this.children) {
      fn(c);
      c._walk(fn);
    }
  }
}

function _matches(el: MockElement, selector: string): boolean {
  if (selector.startsWith(".")) {
    return el.classList.contains(selector.slice(1));
  }
  if (selector.startsWith("#")) {
    return el.getAttribute("id") === selector.slice(1);
  }
  return el.tagName === selector.toUpperCase();
}

function _installMockDocument(): Document {
  const doc = {
    createElement(tag: string): MockElement {
      return new MockElement(tag);
    },
    body: new MockElement("body"),
  };
  // Type-cast: the test runner only consumes the subset we expose.
  return doc as unknown as Document;
}

export function __resetUiMocks(): void {
  _notices.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__readineMockDocument) {
    delete g.__readineMockDocument;
  }
}

/**
 * Test helper — returns a fresh container element bound to the mock DOM.
 * Test code calls this instead of `document.createElement('div')` to avoid
 * the chicken-and-egg with the lazy polyfill installer.
 */
export function __createContainer(): HTMLElement {
  return _ensureDocument().createElement("div");
}

/**
 * Test helper — sets `globalThis.navigator.clipboard.writeText` to a spy.
 * Returns the spy so tests can assert calls. The mock environment doesn't
 * provide a `navigator` by default; this guards against re-entry.
 */
export function __installClipboardSpy(): { writeText: (text: string) => Promise<void>; calls: string[] } {
  const calls: string[] = [];
  const writeText = async (text: string) => {
    calls.push(text);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.navigator) g.navigator = {};
  g.navigator.clipboard = { writeText };
  return { writeText, calls };
}
// END_BLOCK_UI_STUBS

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — added App/Plugin/PluginSettingTab/Modal/Notice/Setting + minimal DOM polyfill for Phase 7 UI tests
// LAST_CHANGE: 2026-06-04 — add apiVersion export for getObsidianVersion fix
// END_CHANGE_SUMMARY
