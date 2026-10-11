import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import {
  ContentItemSchema,
  ContentRevisionSchema,
  createContentRevision,
  createNextContentRevision,
  type ContentItem,
  type ContentKind,
  type ContentRevision,
  type RevisionMedia,
  type SourceAttribution,
} from '../../domain/index.js';

export interface ContentDocument {
  item: ContentItem;
  revision: ContentRevision;
}

export interface CreateContentInput {
  kind: ContentKind;
  title: string;
  bodyMarkdown: string;
  media: RevisionMedia[];
  sourceHash: string | null;
  sourceType: string;
  source?: SourceAttribution | null;
}

export interface ReviseContentInput {
  kind?: ContentKind;
  title?: string;
  bodyMarkdown?: string;
  media?: RevisionMedia[];
  sourceHash?: string | null;
}

interface ContentItemRow {
  id: string;
  kind: ContentKind;
  title: string;
  current_revision_id: string | null;
  source_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ContentRevisionRow {
  id: string;
  item_id: string;
  revision_number: number;
  kind: ContentKind;
  title: string;
  body_markdown: string;
  media_manifest_json: string;
  source_hash: string | null;
  content_hash: string;
  created_at: string;
}

export class ContentRepository {
  public constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateContentInput): ContentDocument {
    const itemId = this.createId();
    const revisionId = this.createId();
    const timestamp = this.now().toISOString();
    const revision = createContentRevision({
      id: revisionId,
      contentItemId: itemId,
      revisionNumber: 1,
      kind: input.kind,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      media: input.media,
      sourceHash: input.sourceHash,
      createdAt: timestamp,
    });
    const item = ContentItemSchema.parse({
      id: itemId,
      kind: input.kind,
      title: input.title,
      currentRevisionId: revisionId,
      source: input.source ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO content_items (
          id, title, kind, source_type, created_at, updated_at, current_revision_id, source_json
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        item.id,
        item.title,
        item.kind,
        input.sourceType,
        item.createdAt,
        item.updatedAt,
        item.source === null ? null : JSON.stringify(item.source),
      );
      this.insertRevision(revision);
      this.database.prepare('UPDATE content_items SET current_revision_id = ? WHERE id = ?')
        .run(revision.id, item.id);
    }).immediate();

    return { item, revision };
  }

  revise(itemId: string, input: ReviseContentInput): ContentDocument {
    const current = this.get(itemId);
    if (current === undefined) {
      throw new Error(`ContentItem not found: ${itemId}`);
    }

    const timestamp = this.now().toISOString();
    const revision = createNextContentRevision(current.revision, {
      id: this.createId(),
      createdAt: timestamp,
      ...input,
    });
    const item = ContentItemSchema.parse({
      ...current.item,
      kind: revision.kind,
      title: revision.title,
      currentRevisionId: revision.id,
      updatedAt: timestamp,
    });

    this.database.transaction(() => {
      this.insertRevision(revision);
      this.database.prepare(`
        UPDATE content_items
        SET title = ?, kind = ?, current_revision_id = ?, updated_at = ?
        WHERE id = ?
      `).run(item.title, item.kind, revision.id, timestamp, item.id);

      this.database.prepare(`
        UPDATE publish_jobs
        SET state = 'CANCELLED', updated_at = ?,
            lease_owner = NULL, lease_until = NULL,
            status_message = 'Content changed; create a new publish plan'
        WHERE plan_id IN (SELECT id FROM publish_plans WHERE revision_id = ?)
          AND state IN ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED')
      `).run(timestamp, current.revision.id);

      this.database.prepare(`
        UPDATE publish_plans
        SET approval_hash = NULL, approved_by = NULL, approved_at = NULL, updated_at = ?
        WHERE revision_id = ?
      `).run(timestamp, current.revision.id);
    }).immediate();

    return { item, revision };
  }

  get(itemId: string): ContentDocument | undefined {
    const itemRow = this.database.prepare(`
      SELECT id, kind, title, current_revision_id, source_json, created_at, updated_at
      FROM content_items
      WHERE id = ?
    `).get(itemId) as ContentItemRow | undefined;
    if (itemRow?.current_revision_id === null || itemRow === undefined) {
      return undefined;
    }

    const revision = this.getRevision(itemRow.current_revision_id);
    if (revision === undefined) {
      throw new Error(`Current revision is missing for ContentItem ${itemRow.id}`);
    }

    return {
      item: ContentItemSchema.parse({
        id: itemRow.id,
        kind: itemRow.kind,
        title: itemRow.title,
        currentRevisionId: itemRow.current_revision_id,
        source: itemRow.source_json === null ? null : JSON.parse(itemRow.source_json),
        createdAt: itemRow.created_at,
        updatedAt: itemRow.updated_at,
      }),
      revision,
    };
  }

  getRevision(revisionId: string): ContentRevision | undefined {
    const row = this.database.prepare(`
      SELECT id, item_id, revision_number, kind, title, body_markdown,
             media_manifest_json, source_hash, content_hash, created_at
      FROM content_revisions
      WHERE id = ?
    `).get(revisionId) as ContentRevisionRow | undefined;

    return row === undefined ? undefined : ContentRevisionSchema.parse({
      id: row.id,
      contentItemId: row.item_id,
      revisionNumber: row.revision_number,
      kind: row.kind,
      title: row.title,
      bodyMarkdown: row.body_markdown,
      media: JSON.parse(row.media_manifest_json),
      sourceHash: row.source_hash,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    });
  }

  list(): ContentDocument[] {
    const ids = this.database.prepare(`
      SELECT id FROM content_items WHERE current_revision_id IS NOT NULL ORDER BY updated_at DESC, id
    `).pluck().all() as string[];

    return ids.map((id) => this.get(id)).filter((document): document is ContentDocument => document !== undefined);
  }

  private insertRevision(revision: ContentRevision): void {
    this.database.prepare(`
      INSERT INTO content_revisions (
        id, item_id, revision_number, title, body_markdown, body_html,
        media_manifest_json, source_metadata_json, content_hash, created_at, kind, source_hash
      ) VALUES (?, ?, ?, ?, ?, '', ?, '{}', ?, ?, ?, ?)
    `).run(
      revision.id,
      revision.contentItemId,
      revision.revisionNumber,
      revision.title,
      revision.bodyMarkdown,
      JSON.stringify(revision.media),
      revision.contentHash,
      revision.createdAt,
      revision.kind,
      revision.sourceHash,
    );
  }
}
