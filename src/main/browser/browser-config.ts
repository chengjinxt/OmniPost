import { isAbsolute } from 'node:path';

import { z } from 'zod';

const AbsolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isAbsolute(value), 'Path must be absolute');

const SafePathSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/);

const PlatformIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

const SelectorSchema = z.string().trim().min(1).max(512);

export const BrowserSelectorConfigSchema = z
  .object({
    title: SelectorSchema.optional(),
    body: SelectorSchema.optional(),
    fileInput: SelectorSchema.optional(),
    saveDraft: SelectorSchema.optional(),
    cancel: SelectorSchema.optional(),
    submit: SelectorSchema.optional(),
    loginRequired: SelectorSchema.optional(),
    captcha: SelectorSchema.optional(),
  })
  .strict();

export const BrowserPlatformConfigSchema = z
  .object({
    platform: PlatformIdSchema,
    editorUrl: z
      .string()
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'https:' || protocol === 'http:' || protocol === 'file:';
      }, 'Editor URL must use HTTPS, HTTP, or file protocol'),
    selectors: BrowserSelectorConfigSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.platform !== 'medium') return;
    const mutationSelectors = [
      'title',
      'body',
      'fileInput',
      'saveDraft',
      'cancel',
      'submit',
    ] as const;
    for (const selector of mutationSelectors) {
      if (value.selectors[selector] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['selectors', selector],
          message: `Medium cannot configure ${selector}`,
        });
      }
    }
  });

export const BrowserEngineConfigSchema = z
  .object({
    profileRoot: AbsolutePathSchema,
    artifactRoot: AbsolutePathSchema,
    platforms: z.array(BrowserPlatformConfigSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const platforms = new Set<string>();
    for (const [index, platform] of value.platforms.entries()) {
      if (platforms.has(platform.platform)) {
        context.addIssue({
          code: 'custom',
          path: ['platforms', index, 'platform'],
          message: `Duplicate platform configuration: ${platform.platform}`,
        });
      }
      platforms.add(platform.platform);
    }
  });

export const OpenEditorInputSchema = z
  .object({
    platform: PlatformIdSchema,
    accountId: SafePathSegmentSchema,
  })
  .strict();

export const PrefillInputSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    filePaths: z.array(AbsolutePathSchema).default([]),
  })
  .strict();

export type BrowserSelectorConfig = z.infer<typeof BrowserSelectorConfigSchema>;
export type BrowserPlatformConfig = z.infer<typeof BrowserPlatformConfigSchema>;
export type BrowserEngineConfig = z.infer<typeof BrowserEngineConfigSchema>;
export type OpenEditorInput = z.input<typeof OpenEditorInputSchema>;
export type PrefillInput = z.input<typeof PrefillInputSchema>;
