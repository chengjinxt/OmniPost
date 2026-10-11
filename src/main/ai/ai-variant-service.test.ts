import { describe, expect, it, vi } from 'vitest';

import { ContentKind } from '../../domain/index.js';
import { ContentRepository } from '../infrastructure/content-repository.js';
import { openDatabase } from '../infrastructure/database.js';
import { PublicationRepository } from '../infrastructure/publication-repository.js';
import type { EncryptionProvider } from '../infrastructure/secret-vault.js';
import { AiProfileRepository } from './ai-profile-repository.js';
import { AiVariantService } from './ai-variant-service.js';

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
};

describe('AiVariantService', () => {
  it('creates and persists a platform variant plus generation provenance without revising the source', async () => {
    const database = openDatabase(':memory:');
    const content = new ContentRepository(database, (() => {
      const ids = ['item-1', 'revision-1'];
      return () => ids.shift() ?? 'unexpected-id';
    })(), () => new Date('2026-10-12T00:00:00.000Z'));
    const source = content.create({
      kind: ContentKind.ARTICLE,
      title: '原稿',
      bodyMarkdown: '原始正文',
      media: [],
      sourceHash: null,
      sourceType: 'MANUAL',
    });
    const profiles = new AiProfileRepository(database, encryption, () => new Date('2026-10-12T00:00:01.000Z'));
    profiles.save({
      baseUrl: 'https://api.example.com/v1', baseUrlId: 'primary', model: 'writer-1',
      endpoint: 'RESPONSES', promptVersion: 'platform-v1', apiKey: 'secret',
    });
    const send = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        status: 'completed', model: 'writer-1',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({
          title: '知乎标题', bodyMarkdown: '知乎正文', platformFields: [{ key: 'topic', value: '创作' }],
        }) }] }],
      },
    });
    const service = new AiVariantService({
      content,
      profiles,
      publications: new PublicationRepository(database),
      transport: { send },
      createId: () => 'variant-1',
      now: () => '2026-10-12T00:00:02.000Z',
    });

    const result = await service.generate({ revisionId: source.revision.id, platform: 'ZHIHU', constraints: {} });

    expect(result.variant).toMatchObject({ id: 'variant-1', revisionId: source.revision.id, title: '知乎标题' });
    expect(content.getRevision(source.revision.id)).toEqual(source.revision);
    expect(database.prepare('SELECT model FROM ai_generation_records WHERE variant_id = ?').pluck().get('variant-1')).toBe('writer-1');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }));
    database.close();
  });
});
