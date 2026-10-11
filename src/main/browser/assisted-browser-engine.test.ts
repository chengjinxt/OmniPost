import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AssistedBrowserEngine,
  BrowserActionNotAllowedError,
  BrowserProfileInUseError,
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

const describeHeadful =
  process.env.OMNIPOST_BROWSER_E2E === '1' ? describe : describe.skip;

describeHeadful('AssistedBrowserEngine headful Edge E2E', () => {
  let temporaryRoot: string;
  let engine: AssistedBrowserEngine | null;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'omnipost-browser-test-'));
    engine = null;
  });

  afterEach(async () => {
    await engine?.closeAll();
    const resolvedRoot = resolve(temporaryRoot);
    if (!resolvedRoot.startsWith(resolve(tmpdir()))) {
      throw new Error(`Refusing to remove non-temporary path: ${resolvedRoot}`);
    }
    await rm(resolvedRoot, { recursive: true, force: true });
  }, 30_000);

  function config(platforms: BrowserEngineConfig['platforms']): BrowserEngineConfig {
    return {
      profileRoot: join(temporaryRoot, 'profiles'),
      artifactRoot: join(temporaryRoot, 'artifacts'),
      platforms,
    };
  }

  it('keeps profiles isolated and never submits during open or prefill', async () => {
    engine = new AssistedBrowserEngine(
      config([{ platform: 'csdn', editorUrl: FIXTURE_URL, selectors }]),
    );
    const uploadPath = join(temporaryRoot, 'cover image.png');
    await writeFile(uploadPath, 'fixture image bytes', 'utf8');

    const first = await engine.openEditor({
      platform: 'csdn',
      accountId: 'account-a',
    });
    expect(first).toMatchObject({ state: 'READY', reason: null });
    expect(first.userDataDir).toBe(join(temporaryRoot, 'profiles', 'csdn', 'account-a'));
    expect(first.currentUrl).not.toContain('submitted');
    await expect(
      engine.openEditor({ platform: 'csdn', accountId: 'account-a' }),
    ).rejects.toBeInstanceOf(BrowserProfileInUseError);

    const prefilled = await engine.prefill(first.sessionId, {
      title: '本地标题',
      body: '本地正文',
      filePaths: [uploadPath],
    });
    expect(prefilled.state).toBe('READY');
    expect(prefilled.currentUrl).not.toContain('submitted');

    const draft = await engine.saveDraft(first.sessionId);
    const decodedDraftUrl = decodeURIComponent(draft.currentUrl);
    expect(draft.state).toBe('DRAFT_SAVED');
    expect(decodedDraftUrl).toContain('draft:');
    expect(decodedDraftUrl).toContain('"title":"本地标题"');
    expect(decodedDraftUrl).toContain('"body":"本地正文"');
    expect(decodedDraftUrl).toContain('"files":["cover image.png"]');
    expect(decodedDraftUrl).not.toContain('submitted');

    const screenshot = await engine.takeScreenshot(first.sessionId);
    expect((await stat(screenshot.artifactPath)).size).toBeGreaterThan(0);
    const trace = await engine.saveTrace(first.sessionId);
    expect((await stat(trace.artifactPath)).size).toBeGreaterThan(0);

    const submitted = await engine.confirmSubmit(first.sessionId);
    expect(submitted.state).toBe('SUBMITTED');
    expect(decodeURIComponent(submitted.currentUrl)).toContain('submitted:');
    await engine.closeSession(first.sessionId);

    const second = await engine.openEditor({
      platform: 'csdn',
      accountId: 'account-b',
    });
    expect(second.userDataDir).toBe(join(temporaryRoot, 'profiles', 'csdn', 'account-b'));
    expect(second.userDataDir).not.toBe(first.userDataDir);
  }, 30_000);

  it('returns NEEDS_ACTION for login and captcha gates without filling or submitting', async () => {
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
  }, 30_000);

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
  }, 30_000);
});
