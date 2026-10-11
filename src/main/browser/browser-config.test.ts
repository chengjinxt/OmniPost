import { describe, expect, it } from 'vitest';

import {
  BrowserEngineConfigSchema,
  OpenEditorInputSchema,
  PrefillInputSchema,
} from './browser-config.js';

const ABSOLUTE_ROOT = 'C:\\OmniPost\\browser-data';

describe('browser configuration validation', () => {
  it('rejects relative paths, blank selectors, and unsafe account path segments', () => {
    expect(() =>
      BrowserEngineConfigSchema.parse({
        profileRoot: 'relative/profiles',
        artifactRoot: ABSOLUTE_ROOT,
        platforms: [],
      }),
    ).toThrow();

    expect(() =>
      BrowserEngineConfigSchema.parse({
        profileRoot: ABSOLUTE_ROOT,
        artifactRoot: `${ABSOLUTE_ROOT}\\artifacts`,
        platforms: [
          {
            platform: 'csdn',
            editorUrl: 'file:///C:/fixtures/editor.html',
            selectors: { title: '   ' },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      OpenEditorInputSchema.parse({ platform: 'csdn', accountId: '../other' }),
    ).toThrow();

    expect(() =>
      PrefillInputSchema.parse({ filePaths: ['relative/image.png'] }),
    ).toThrow();
  });

  it('forbids every page mutation selector in Medium configuration', () => {
    for (const selectorName of [
      'title',
      'body',
      'fileInput',
      'saveDraft',
      'cancel',
      'submit',
    ]) {
      expect(() =>
        BrowserEngineConfigSchema.parse({
          profileRoot: ABSOLUTE_ROOT,
          artifactRoot: `${ABSOLUTE_ROOT}\\artifacts`,
          platforms: [
            {
              platform: 'medium',
              editorUrl: 'https://medium.com/new-story',
              selectors: { [selectorName]: '#forbidden' },
            },
          ],
        }),
      ).toThrow();
    }
  });

  it('accepts a strict selector map with login and captcha gates', () => {
    const config = BrowserEngineConfigSchema.parse({
      profileRoot: ABSOLUTE_ROOT,
      artifactRoot: `${ABSOLUTE_ROOT}\\artifacts`,
      platforms: [
        {
          platform: 'csdn',
          editorUrl: 'file:///C:/fixtures/editor.html',
          selectors: {
            title: '#title',
            body: '#body',
            fileInput: '#media',
            saveDraft: '#save-draft',
            cancel: '#cancel',
            submit: '#submit',
            loginRequired: '#login-gate',
            captcha: '#captcha-gate',
          },
        },
      ],
    });

    expect(config.platforms[0]?.selectors.submit).toBe('#submit');
  });
});
