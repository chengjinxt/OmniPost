import { z } from 'zod';

import { JsonObjectSchema, type ContentRevision, type PlatformVariant } from '../../domain/index.js';
import type { PublicationRepository } from '../infrastructure/publication-repository.js';
import type { AiProfileRepository } from './ai-profile-repository.js';
import {
  OpenAiCompatibleVariantGenerator,
  type AiHttpTransport,
  type AiVariantGeneration,
} from './ai-variant-generator.js';

const GenerateVariantRequestSchema = z.object({
  revisionId: z.string().min(1),
  platform: z.string().min(1),
  constraints: JsonObjectSchema,
}).strict();

export type GenerateVariantRequest = z.input<typeof GenerateVariantRequestSchema>;

interface RevisionSource {
  getRevision(revisionId: string): ContentRevision | undefined;
}

interface AiVariantServiceDependencies {
  content: RevisionSource;
  profiles: AiProfileRepository;
  publications: Pick<PublicationRepository, 'saveVariant'>;
  transport: AiHttpTransport;
  createId?: () => string;
  now?: () => string;
}

export class AiVariantService {
  constructor(private readonly dependencies: AiVariantServiceDependencies) {}

  async generate(requestValue: GenerateVariantRequest): Promise<AiVariantGeneration> {
    const request = GenerateVariantRequestSchema.parse(requestValue);
    const revision = this.dependencies.content.getRevision(request.revisionId);
    if (revision === undefined) throw new Error(`Unknown content revision: ${request.revisionId}`);
    const profile = this.dependencies.profiles.getRuntime();
    if (profile === null) throw new Error('AI provider is not configured');

    const generator = new OpenAiCompatibleVariantGenerator({
      transport: this.dependencies.transport,
      config: profile.config,
      ...(this.dependencies.createId === undefined ? {} : { createId: this.dependencies.createId }),
      ...(this.dependencies.now === undefined ? {} : { now: this.dependencies.now }),
    });
    const generated = await generator.generate({
      revision,
      platform: request.platform,
      constraints: request.constraints,
      promptVersion: profile.promptVersion,
    });
    const variant: PlatformVariant = this.dependencies.publications.saveVariant(generated.variant);
    this.dependencies.profiles.recordGeneration(generated.generation);
    return { ...generated, variant };
  }
}
