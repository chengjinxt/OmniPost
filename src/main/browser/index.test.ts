import { describe, expect, it } from 'vitest';

import {
  AssistedBrowserEngine,
  BrowserEngineConfigSchema,
  BrowserActionNotAllowedError,
} from './index.js';

describe('browser public API', () => {
  it('exports the assisted engine and validated configuration contract', () => {
    expect(AssistedBrowserEngine).toBeTypeOf('function');
    expect(BrowserActionNotAllowedError).toBeTypeOf('function');
    expect(BrowserEngineConfigSchema.parse).toBeTypeOf('function');
  });
});
