import { describe, expect, it, vi } from 'vitest';

import { ContentKind, createContentRevision } from '../domain/index.js';
import { ManualHandoffService } from './manual-handoff-service.js';

const revision = createContentRevision({
  id: 'revision-1', contentItemId: 'item-1', revisionNumber: 1,
  kind: ContentKind.ARTICLE, title: '安全标题', bodyMarkdown: '# 正文\n\n<script>alert(1)</script>',
  media: [], sourceHash: null, createdAt: '2026-10-12T00:00:00.000Z',
});

describe('ManualHandoffService', () => {
  it('exports Medium-ready Markdown and HTML with a canonical URL suggestion', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const service = new ManualHandoffService({
      revisions: { getRevision: () => revision },
      save,
      openExternal: vi.fn(),
    });

    await expect(service.export({
      revisionId: revision.id,
      platform: 'MEDIUM',
      format: 'MARKDOWN',
      canonicalUrl: 'https://example.com/original',
    })).resolves.toEqual({ cancelled: false, suggestedName: '安全标题-medium.md' });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: '安全标题-medium.md',
      content: expect.stringContaining('canonical_url: https://example.com/original'),
    }));

    await service.export({
      revisionId: revision.id, platform: 'MEDIUM', format: 'HTML', canonicalUrl: null,
    });
    const html = save.mock.calls[1]?.[0]?.content as string;
    expect(html).toContain('<h1>正文</h1>');
    expect(html).not.toContain('<script>');
  });

  it('only opens the public editor and never fills or submits Medium', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const service = new ManualHandoffService({
      revisions: { getRevision: () => revision },
      save: vi.fn(),
      openExternal,
    });

    await service.openEditor('MEDIUM');

    expect(openExternal).toHaveBeenCalledWith('https://medium.com/new-story');
  });
});
