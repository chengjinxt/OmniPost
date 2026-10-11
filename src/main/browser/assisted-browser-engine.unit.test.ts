import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AssistedBrowserEngine,
  BrowserActionNotAllowedError,
  BrowserProfileInUseError,
  type BrowserContextPort,
  type BrowserLaunchOptions,
  type BrowserLocatorPort,
  type BrowserPagePort,
  type BrowserTracingPort,
  type PersistentContextLauncher,
} from './assisted-browser-engine.js';
import type { BrowserEngineConfig } from './browser-config.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'editor.html',
);
const FIXTURE_URL = pathToFileURL(FIXTURE_PATH).href;

const selectors = {
  title: '#title',
  body: '#body',
  fileInput: '#media',
  saveDraft: '#save-draft',
  cancel: '#cancel',
  submit: '#submit',
  loginRequired: '#login-gate',
  captcha: '#captcha-gate',
};

class FixtureLocator implements BrowserLocatorPort {
  readonly #page: FixturePage;
  readonly #selector: string;

  constructor(page: FixturePage, selector: string) {
    this.#page = page;
    this.#selector = selector;
  }

  first(): BrowserLocatorPort {
    return this;
  }

  async isVisible(): Promise<boolean> {
    return this.#page.isVisible(this.#selector);
  }

  async fill(value: string): Promise<void> {
    this.#page.fill(this.#selector, value);
  }

  async setInputFiles(filePaths: string[]): Promise<void> {
    this.#page.setInputFiles(this.#selector, filePaths);
  }

  async click(): Promise<void> {
    this.#page.click(this.#selector);
  }
}

class FixturePage implements BrowserPagePort {
  #html = '';
  #currentUrl = 'https://fixture.invalid/';
  readonly #fields = {
    title: '',
    body: '',
    files: [] as string[],
  };

  async goto(
    url: string,
    _options: { waitUntil: 'domcontentloaded' },
  ): Promise<void> {
    this.#html = await readFile(fileURLToPath(new URL(url)), 'utf8');
    this.#currentUrl = url;
  }

  locator(selector: string): BrowserLocatorPort {
    return new FixtureLocator(this, selector);
  }

  url(): string {
    return this.#currentUrl;
  }

  async screenshot(options: { path: string; fullPage: true }): Promise<void> {
    await writeFile(options.path, 'fixture screenshot', 'utf8');
  }

  async copyToClipboard(_text: string): Promise<void> {
    // The engine's clipboardWriter dependency is used by unit tests.
  }

  isVisible(selector: string): boolean {
    const gate = this.#attribute(selector, 'data-gate');
    if (!gate) return true;
    return new URL(this.#currentUrl).searchParams.get('gate') === gate;
  }

  fill(selector: string, value: string): void {
    const field = this.#attribute(selector, 'data-field');
    if (field === 'title' || field === 'body') {
      this.#fields[field] = value;
      return;
    }
    throw new Error(`Fixture selector is not fillable: ${selector}`);
  }

  setInputFiles(selector: string, filePaths: string[]): void {
    if (this.#attribute(selector, 'data-field') !== 'files') {
      throw new Error(`Fixture selector is not a file input: ${selector}`);
    }
    this.#fields.files = filePaths.map((filePath) => basename(filePath));
  }

  click(selector: string): void {
    const action = this.#attribute(selector, 'data-action');
    if (!action) throw new Error(`Fixture selector is not clickable: ${selector}`);
    const current = new URL(this.#currentUrl);
    current.hash = `${action}:${encodeURIComponent(JSON.stringify(this.#fields))}`;
    this.#currentUrl = current.href;
  }

  close(): void {}

  #attribute(selector: string, attribute: string): string | null {
    if (!selector.startsWith('#')) {
      throw new Error(`Fixture runtime accepts only id selectors: ${selector}`);
    }
    const id = selector.slice(1);
    const doubleQuotedId = `id="${id}"`;
    const singleQuotedId = `id='${id}'`;
    const idOffset = Math.max(
      this.#html.indexOf(doubleQuotedId),
      this.#html.indexOf(singleQuotedId),
    );
    if (idOffset < 0) throw new Error(`Fixture selector not found: ${selector}`);
    const tagStart = this.#html.lastIndexOf('<', idOffset);
    const tagEnd = this.#html.indexOf('>', idOffset);
    const tag = this.#html.slice(tagStart, tagEnd + 1);
    const match = tag.match(
      new RegExp(`\\b${attribute}=(?:"([^"]*)"|'([^']*)')`),
    );
    return match?.[1] ?? match?.[2] ?? null;
  }
}

class FixtureTracing implements BrowserTracingPort {
  async start(_options: {
    screenshots: true;
    snapshots: true;
    sources: true;
  }): Promise<void> {}

  async stop(options?: { path: string }): Promise<void> {
    if (options) await writeFile(options.path, 'fixture trace', 'utf8');
  }
}

class FixtureContext implements BrowserContextPort {
  readonly tracing = new FixtureTracing();
  readonly page = new FixturePage();

  pages(): BrowserPagePort[] {
    return [this.page];
  }

  async newPage(): Promise<BrowserPagePort> {
    return this.page;
  }

  async close(): Promise<void> {
    this.page.close();
  }
}

class FixtureLauncher implements PersistentContextLauncher {
  readonly calls: Array<{
    userDataDir: string;
    options: BrowserLaunchOptions;
  }> = [];

  async launchPersistentContext(
    userDataDir: string,
    options: BrowserLaunchOptions,
  ): Promise<BrowserContextPort> {
    this.calls.push({ userDataDir, options });
    return new FixtureContext();
  }
}

describe('AssistedBrowserEngine unit', () => {
  let temporaryRoot: string;
  let engine: AssistedBrowserEngine | null;
  let launcher: FixtureLauncher;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'omnipost-browser-unit-'));
    engine = null;
    launcher = new FixtureLauncher();
  });

  afterEach(async () => {
    await engine?.closeAll();
    const resolvedRoot = resolve(temporaryRoot);
    if (!resolvedRoot.startsWith(resolve(tmpdir()))) {
      throw new Error(`Refusing to remove non-temporary path: ${resolvedRoot}`);
    }
    await rm(resolvedRoot, { recursive: true, force: true });
  });

  function config(platforms: BrowserEngineConfig['platforms']): BrowserEngineConfig {
    return {
      profileRoot: join(temporaryRoot, 'profiles'),
      artifactRoot: join(temporaryRoot, 'artifacts'),
      platforms,
    };
  }

  it('uses an injected visible runtime, isolates profiles, and submits only after confirmation', async () => {
    engine = new AssistedBrowserEngine(
      config([{ platform: 'csdn', editorUrl: FIXTURE_URL, selectors }]),
      { launcher },
    );
    const uploadPath = join(temporaryRoot, 'cover image.png');
    await writeFile(uploadPath, 'fixture image bytes', 'utf8');

    const first = await engine.openEditor({
      platform: 'csdn',
      accountId: 'account-a',
    });
    expect(launcher.calls).toEqual([
      {
        userDataDir: join(temporaryRoot, 'profiles', 'csdn', 'account-a'),
        options: {
          headless: false,
          channel: 'msedge',
          viewport: { width: 1280, height: 900 },
        },
      },
    ]);
    expect(first).toMatchObject({ state: 'READY', reason: null });
    expect(first.currentUrl).not.toContain('submitted');
    await expect(
      engine.openEditor({ platform: 'csdn', accountId: 'account-a' }),
    ).rejects.toBeInstanceOf(BrowserProfileInUseError);

    const prefilled = await engine.prefill(first.sessionId, {
      title: '本地标题',
      body: '本地正文',
      filePaths: [uploadPath],
    });
    expect(prefilled.currentUrl).not.toContain('submitted');

    const draft = await engine.saveDraft(first.sessionId);
    const decodedDraftUrl = decodeURIComponent(draft.currentUrl);
    expect(decodedDraftUrl).toContain('draft:');
    expect(decodedDraftUrl).toContain('"title":"本地标题"');
    expect(decodedDraftUrl).toContain('"body":"本地正文"');
    expect(decodedDraftUrl).toContain('"files":["cover image.png"]');
    expect(decodedDraftUrl).not.toContain('submitted');

    const cancelled = await engine.cancel(first.sessionId);
    expect(decodeURIComponent(cancelled.currentUrl)).toContain('cancelled:');
    expect(cancelled.currentUrl).not.toContain('submitted');

    const screenshot = await engine.takeScreenshot(first.sessionId);
    expect((await stat(screenshot.artifactPath)).size).toBeGreaterThan(0);
    const trace = await engine.saveTrace(first.sessionId);
    expect((await stat(trace.artifactPath)).size).toBeGreaterThan(0);

    const submitted = await engine.confirmSubmit(first.sessionId);
    expect(decodeURIComponent(submitted.currentUrl)).toContain('submitted:');
    await engine.closeSession(first.sessionId);

    const second = await engine.openEditor({
      platform: 'csdn',
      accountId: 'account-b',
    });
    expect(second.userDataDir).toBe(
      join(temporaryRoot, 'profiles', 'csdn', 'account-b'),
    );
    expect(second.userDataDir).not.toBe(first.userDataDir);
  });

  it('returns NEEDS_ACTION for login and captcha without filling or submitting', async () => {
    engine = new AssistedBrowserEngine(
      config([
        {
          platform: 'login-fixture',
          editorUrl: `${FIXTURE_URL}?gate=login`,
          selectors,
        },
        {
          platform: 'captcha-fixture',
          editorUrl: `${FIXTURE_URL}?gate=captcha`,
          selectors,
        },
      ]),
      { launcher },
    );

    for (const expectation of [
      { platform: 'login-fixture', reason: 'LOGIN_REQUIRED' },
      { platform: 'captcha-fixture', reason: 'CAPTCHA_REQUIRED' },
    ] as const) {
      const session = await engine.openEditor({
        platform: expectation.platform,
        accountId: 'account-a',
      });
      expect(session).toMatchObject({
        state: 'NEEDS_ACTION',
        reason: expectation.reason,
      });

      const prefill = await engine.prefill(session.sessionId, {
        title: '不得自动填写',
        body: '不得自动提交',
      });
      expect(prefill).toMatchObject({
        state: 'NEEDS_ACTION',
        reason: expectation.reason,
      });
      const submit = await engine.confirmSubmit(session.sessionId);
      expect(submit).toMatchObject({
        state: 'NEEDS_ACTION',
        reason: expectation.reason,
      });
      expect(submit.currentUrl).not.toContain('submitted');
      await engine.closeSession(session.sessionId);
    }
  });

  it('restricts Medium to open, export, and copy operations', async () => {
    const copied: string[] = [];
    engine = new AssistedBrowserEngine(
      config([
        {
          platform: 'medium',
          editorUrl: FIXTURE_URL,
          selectors: {
            loginRequired: '#login-gate',
            captcha: '#captcha-gate',
          },
        },
      ]),
      {
        launcher,
        clipboardWriter: async (text) => {
          copied.push(text);
        },
      },
    );
    const session = await engine.openEditor({
      platform: 'medium',
      accountId: 'writer-a',
    });

    await expect(
      engine.prefill(session.sessionId, { title: '禁止填写' }),
    ).rejects.toBeInstanceOf(BrowserActionNotAllowedError);
    await expect(engine.saveDraft(session.sessionId)).rejects.toBeInstanceOf(
      BrowserActionNotAllowedError,
    );
    await expect(engine.cancel(session.sessionId)).rejects.toBeInstanceOf(
      BrowserActionNotAllowedError,
    );
    await expect(engine.confirmSubmit(session.sessionId)).rejects.toBeInstanceOf(
      BrowserActionNotAllowedError,
    );

    const exported = await engine.exportForManualHandoff(session.sessionId, {
      title: '手动发布标题',
      body: '手动发布正文',
    });
    expect(exported.state).toBe('EXPORTED');
    expect(JSON.parse(await readFile(exported.artifactPath, 'utf8'))).toMatchObject({
      platform: 'medium',
      accountId: 'writer-a',
      content: { title: '手动发布标题', body: '手动发布正文' },
    });

    const copiedResult = await engine.copyForManualHandoff(
      session.sessionId,
      '手动发布标题\n\n手动发布正文',
    );
    expect(copiedResult.state).toBe('COPIED');
    expect(copied).toEqual(['手动发布标题\n\n手动发布正文']);
    expect(copiedResult.currentUrl).not.toContain('submitted');
  });
});
