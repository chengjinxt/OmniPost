import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright';
import { z } from 'zod';

import {
  BrowserEngineConfigSchema,
  OpenEditorInputSchema,
  PrefillInputSchema,
  type BrowserEngineConfig,
  type BrowserPlatformConfig,
  type OpenEditorInput,
  type PrefillInput,
} from './browser-config.js';

export type BrowserSessionState =
  | 'READY'
  | 'NEEDS_ACTION'
  | 'DRAFT_SAVED'
  | 'CANCELLED'
  | 'SUBMITTED';

export type BrowserNeedsActionReason =
  | 'LOGIN_REQUIRED'
  | 'CAPTCHA_REQUIRED';

export interface BrowserSessionResult {
  sessionId: string;
  state: BrowserSessionState;
  reason: BrowserNeedsActionReason | null;
  currentUrl: string;
  userDataDir: string;
}

export interface BrowserArtifactResult {
  state: 'SCREENSHOT_SAVED' | 'TRACE_SAVED' | 'EXPORTED';
  sessionId: string;
  currentUrl: string;
  artifactPath: string;
}

export interface BrowserCopyResult {
  state: 'COPIED';
  sessionId: string;
  currentUrl: string;
}

export interface BrowserLaunchOptions {
  headless: false;
  channel: 'msedge';
  viewport: {
    width: number;
    height: number;
  };
}

export interface BrowserLocatorPort {
  first(): BrowserLocatorPort;
  isVisible(): Promise<boolean>;
  fill(value: string): Promise<void>;
  setInputFiles(filePaths: string[]): Promise<void>;
  click(): Promise<void>;
}

export interface BrowserPagePort {
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded' },
  ): Promise<void>;
  locator(selector: string): BrowserLocatorPort;
  url(): string;
  screenshot(options: { path: string; fullPage: true }): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
}

export interface BrowserTracingPort {
  start(options: {
    screenshots: true;
    snapshots: true;
    sources: true;
  }): Promise<void>;
  stop(options?: { path: string }): Promise<void>;
}

export interface BrowserContextPort {
  readonly tracing: BrowserTracingPort;
  pages(): BrowserPagePort[];
  newPage(): Promise<BrowserPagePort>;
  close(): Promise<void>;
}

export interface PersistentContextLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: BrowserLaunchOptions,
  ): Promise<BrowserContextPort>;
}

export interface AssistedBrowserEngineDependencies {
  clipboardWriter?: (text: string) => Promise<void>;
  launcher?: PersistentContextLauncher;
}

interface BrowserSession {
  id: string;
  platform: BrowserPlatformConfig;
  accountId: string;
  userDataDir: string;
  context: BrowserContextPort;
  page: BrowserPagePort;
  state: BrowserSessionState;
  reason: BrowserNeedsActionReason | null;
  traceActive: boolean;
}

const CopyTextSchema = z.string().min(1);

class PlaywrightLocatorPort implements BrowserLocatorPort {
  readonly #locator: Locator;

  constructor(locator: Locator) {
    this.#locator = locator;
  }

  first(): BrowserLocatorPort {
    return new PlaywrightLocatorPort(this.#locator.first());
  }

  async isVisible(): Promise<boolean> {
    return this.#locator.isVisible();
  }

  async fill(value: string): Promise<void> {
    await this.#locator.fill(value);
  }

  async setInputFiles(filePaths: string[]): Promise<void> {
    await this.#locator.setInputFiles(filePaths);
  }

  async click(): Promise<void> {
    await this.#locator.click();
  }
}

class PlaywrightPagePort implements BrowserPagePort {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async goto(
    url: string,
    options: { waitUntil: 'domcontentloaded' },
  ): Promise<void> {
    await this.#page.goto(url, options);
  }

  locator(selector: string): BrowserLocatorPort {
    return new PlaywrightLocatorPort(this.#page.locator(selector));
  }

  url(): string {
    return this.#page.url();
  }

  async screenshot(options: { path: string; fullPage: true }): Promise<void> {
    await this.#page.screenshot(options);
  }

  async copyToClipboard(text: string): Promise<void> {
    await this.#page.evaluate(
      async (clipboardText) => navigator.clipboard.writeText(clipboardText),
      text,
    );
  }
}

class PlaywrightContextPort implements BrowserContextPort {
  readonly #context: BrowserContext;
  readonly tracing: BrowserTracingPort;

  constructor(context: BrowserContext) {
    this.#context = context;
    this.tracing = {
      start: async (options) => {
        await this.#context.tracing.start(options);
      },
      stop: async (options) => {
        await this.#context.tracing.stop(options);
      },
    };
  }

  pages(): BrowserPagePort[] {
    return this.#context.pages().map((page) => new PlaywrightPagePort(page));
  }

  async newPage(): Promise<BrowserPagePort> {
    return new PlaywrightPagePort(await this.#context.newPage());
  }

  async close(): Promise<void> {
    await this.#context.close();
  }
}

const PlaywrightPersistentContextLauncher: PersistentContextLauncher = {
  async launchPersistentContext(userDataDir, options) {
    return new PlaywrightContextPort(
      await chromium.launchPersistentContext(userDataDir, options),
    );
  },
};

export class BrowserActionNotAllowedError extends Error {
  constructor(platform: string, action: string) {
    super(`${platform} does not allow browser action: ${action}`);
    this.name = 'BrowserActionNotAllowedError';
  }
}

export class BrowserSelectorMissingError extends Error {
  constructor(platform: string, selectorName: string) {
    super(`${platform} has no configured selector for ${selectorName}`);
    this.name = 'BrowserSelectorMissingError';
  }
}

export class BrowserProfileInUseError extends Error {
  constructor(userDataDir: string) {
    super(`Browser profile is already in use: ${userDataDir}`);
    this.name = 'BrowserProfileInUseError';
  }
}

export class AssistedBrowserEngine {
  readonly #config: BrowserEngineConfig;
  readonly #platforms: ReadonlyMap<string, BrowserPlatformConfig>;
  readonly #clipboardWriter: ((text: string) => Promise<void>) | undefined;
  readonly #launcher: PersistentContextLauncher;
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #profileLocks = new Set<string>();

  constructor(
    config: unknown,
    dependencies: AssistedBrowserEngineDependencies = {},
  ) {
    this.#config = BrowserEngineConfigSchema.parse(config);
    this.#platforms = new Map(
      this.#config.platforms.map((platform) => [platform.platform, platform]),
    );
    this.#clipboardWriter = dependencies.clipboardWriter;
    this.#launcher = dependencies.launcher ?? PlaywrightPersistentContextLauncher;
  }

  async openEditor(input: OpenEditorInput): Promise<BrowserSessionResult> {
    const parsed = OpenEditorInputSchema.parse(input);
    const platform = this.#platforms.get(parsed.platform);
    if (!platform) {
      throw new Error(`Unknown browser platform: ${parsed.platform}`);
    }

    const userDataDir = join(
      this.#config.profileRoot,
      platform.platform,
      parsed.accountId,
    );
    if (this.#profileLocks.has(userDataDir)) {
      throw new BrowserProfileInUseError(userDataDir);
    }
    this.#profileLocks.add(userDataDir);

    let context: BrowserContextPort | null = null;

    try {
      await mkdir(userDataDir, { recursive: true });
      context = await this.#launcher.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'msedge',
        viewport: { width: 1280, height: 900 },
      });
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(platform.editorUrl, { waitUntil: 'domcontentloaded' });
      const session: BrowserSession = {
        id: randomUUID(),
        platform,
        accountId: parsed.accountId,
        userDataDir,
        context,
        page,
        state: 'READY',
        reason: null,
        traceActive: true,
      };
      this.#sessions.set(session.id, session);
      await this.#refreshNeedsAction(session);
      return this.#result(session);
    } catch (error) {
      this.#profileLocks.delete(userDataDir);
      await context?.close();
      throw error;
    }
  }

  async prefill(
    sessionId: string,
    input: PrefillInput,
  ): Promise<BrowserSessionResult> {
    const session = this.#requireSession(sessionId);
    this.#assertMutationAllowed(session, 'fill');
    const parsed = PrefillInputSchema.parse(input);
    if (await this.#refreshNeedsAction(session)) return this.#result(session);

    if (parsed.title !== undefined) {
      await session.page
        .locator(this.#selector(session, 'title'))
        .fill(parsed.title);
    }
    if (parsed.body !== undefined) {
      await session.page
        .locator(this.#selector(session, 'body'))
        .fill(parsed.body);
    }
    if (parsed.filePaths.length > 0) {
      await session.page
        .locator(this.#selector(session, 'fileInput'))
        .setInputFiles(parsed.filePaths);
    }
    session.state = 'READY';
    session.reason = null;
    return this.#result(session);
  }

  async saveDraft(sessionId: string): Promise<BrowserSessionResult> {
    const session = this.#requireSession(sessionId);
    this.#assertMutationAllowed(session, 'saveDraft');
    if (await this.#refreshNeedsAction(session)) return this.#result(session);
    await session.page.locator(this.#selector(session, 'saveDraft')).click();
    session.state = 'DRAFT_SAVED';
    session.reason = null;
    return this.#result(session);
  }

  async cancel(sessionId: string): Promise<BrowserSessionResult> {
    const session = this.#requireSession(sessionId);
    this.#assertMutationAllowed(session, 'cancel');
    if (await this.#refreshNeedsAction(session)) return this.#result(session);
    await session.page.locator(this.#selector(session, 'cancel')).click();
    session.state = 'CANCELLED';
    session.reason = null;
    return this.#result(session);
  }

  async confirmSubmit(sessionId: string): Promise<BrowserSessionResult> {
    const session = this.#requireSession(sessionId);
    this.#assertMutationAllowed(session, 'submit');
    if (await this.#refreshNeedsAction(session)) return this.#result(session);
    await session.page.locator(this.#selector(session, 'submit')).click();
    session.state = 'SUBMITTED';
    session.reason = null;
    return this.#result(session);
  }

  async takeScreenshot(sessionId: string): Promise<BrowserArtifactResult> {
    const session = this.#requireSession(sessionId);
    const artifactPath = await this.#artifactPath(
      session,
      `${session.id}-screenshot.png`,
    );
    await session.page.screenshot({ path: artifactPath, fullPage: true });
    return {
      state: 'SCREENSHOT_SAVED',
      sessionId,
      currentUrl: session.page.url(),
      artifactPath,
    };
  }

  async saveTrace(sessionId: string): Promise<BrowserArtifactResult> {
    const session = this.#requireSession(sessionId);
    if (!session.traceActive) {
      throw new Error(`Trace has already been saved for session: ${sessionId}`);
    }
    const artifactPath = await this.#artifactPath(
      session,
      `${session.id}-trace.zip`,
    );
    await session.context.tracing.stop({ path: artifactPath });
    session.traceActive = false;
    return {
      state: 'TRACE_SAVED',
      sessionId,
      currentUrl: session.page.url(),
      artifactPath,
    };
  }

  async exportForManualHandoff(
    sessionId: string,
    input: PrefillInput,
  ): Promise<BrowserArtifactResult> {
    const session = this.#requireSession(sessionId);
    const content = PrefillInputSchema.parse(input);
    const artifactPath = await this.#artifactPath(
      session,
      `${session.id}-manual-handoff.json`,
    );
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          platform: session.platform.platform,
          accountId: session.accountId,
          content,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return {
      state: 'EXPORTED',
      sessionId,
      currentUrl: session.page.url(),
      artifactPath,
    };
  }

  async copyForManualHandoff(
    sessionId: string,
    text: string,
  ): Promise<BrowserCopyResult> {
    const session = this.#requireSession(sessionId);
    const parsed = CopyTextSchema.parse(text);
    if (this.#clipboardWriter) {
      await this.#clipboardWriter(parsed);
    } else {
      await session.page.copyToClipboard(parsed);
    }
    return {
      state: 'COPIED',
      sessionId,
      currentUrl: session.page.url(),
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    this.#sessions.delete(sessionId);
    try {
      if (session.traceActive) {
        await session.context.tracing.stop();
        session.traceActive = false;
      }
    } finally {
      try {
        await session.context.close();
      } finally {
        this.#profileLocks.delete(session.userDataDir);
      }
    }
  }

  async closeAll(): Promise<void> {
    const sessionIds = [...this.#sessions.keys()];
    await Promise.all(sessionIds.map((sessionId) => this.closeSession(sessionId)));
  }

  #requireSession(sessionId: string): BrowserSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown browser session: ${sessionId}`);
    return session;
  }

  #assertMutationAllowed(session: BrowserSession, action: string): void {
    if (session.platform.platform === 'medium') {
      throw new BrowserActionNotAllowedError(session.platform.platform, action);
    }
  }

  #selector(
    session: BrowserSession,
    name: 'title' | 'body' | 'fileInput' | 'saveDraft' | 'cancel' | 'submit',
  ): string {
    const selector = session.platform.selectors[name];
    if (!selector) {
      throw new BrowserSelectorMissingError(session.platform.platform, name);
    }
    return selector;
  }

  async #refreshNeedsAction(session: BrowserSession): Promise<boolean> {
    const loginSelector = session.platform.selectors.loginRequired;
    if (
      loginSelector &&
      (await session.page.locator(loginSelector).first().isVisible())
    ) {
      session.state = 'NEEDS_ACTION';
      session.reason = 'LOGIN_REQUIRED';
      return true;
    }

    const captchaSelector = session.platform.selectors.captcha;
    if (
      captchaSelector &&
      (await session.page.locator(captchaSelector).first().isVisible())
    ) {
      session.state = 'NEEDS_ACTION';
      session.reason = 'CAPTCHA_REQUIRED';
      return true;
    }

    session.state = 'READY';
    session.reason = null;
    return false;
  }

  #result(session: BrowserSession): BrowserSessionResult {
    return {
      sessionId: session.id,
      state: session.state,
      reason: session.reason,
      currentUrl: session.page.url(),
      userDataDir: session.userDataDir,
    };
  }

  async #artifactPath(session: BrowserSession, filename: string): Promise<string> {
    const directory = join(
      this.#config.artifactRoot,
      session.platform.platform,
      session.accountId,
    );
    await mkdir(directory, { recursive: true });
    return join(directory, filename);
  }
}
