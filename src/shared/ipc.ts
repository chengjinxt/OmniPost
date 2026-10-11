import { z } from 'zod';

export const appMetadataSchema = z.object({
  name: z.literal('OmniPost'),
  tagline: z.string().min(1),
  defaultLocale: z.literal('zh-CN'),
  defaultTimeZone: z.literal('Asia/Shanghai'),
});

export type AppMetadata = z.infer<typeof appMetadataSchema>;

export interface OmniPostApi {
  getMetadata(): Promise<AppMetadata>;
}
