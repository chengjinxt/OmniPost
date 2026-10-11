import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import {
  ContentRevisionSchema,
  PlatformVariantSchema,
  PublishJobSchema,
  PublishPlanSchema,
  Sha256Schema,
  approvePublishPlan,
  createPublishIdempotencyKey,
  createPublishPlan,
  type ContentRevision,
  type PlatformVariant,
  type PublishJob,
  type PublishPlan,
  type PublishTarget,
} from '../../domain/index.js';

type IdFactory = () => string;
type Clock = () => Date;

export interface CreateStoredPlanInput {
  revision: ContentRevision;
  variants: readonly PlatformVariant[];
  targets: readonly PublishTarget[];
}

export interface StoredPublicationPlan {
  plan: PublishPlan;
  jobs: PublishJob[];
}

interface PlanRow {
  id: string;
  revision_id: string;
  variant_ids_json: string;
  targets_json: string;
  content_hash: string;
  approval_hash: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  plan_id: string;
  revision_id: string;
  variant_id: string | null;
  account_id: string;
  platform: string;
  delivery_mode: string;
  state: string;
  idempotency_key: string;
  scheduled_at: string | null;
  attempt_count: number;
  remote_publication_id: string | null;
  status_message: string | null;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  item_id: string;
  revision_number: number;
  kind: string;
  title: string;
  body_markdown: string;
  media_manifest_json: string;
  source_hash: string | null;
  content_hash: string;
  created_at: string;
}

interface VariantRow {
  id: string;
  revision_id: string;
  platform: string;
  title: string | null;
  body_markdown: string | null;
  media_manifest_json: string;
  fields_json: string;
  variant_hash: string;
  created_at: string;
}

export class PublicationRepository {
  public constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly createId: IdFactory = randomUUID,
    private readonly now: Clock = () => new Date(),
  ) {}

  saveVariant(variantInput: PlatformVariant): PlatformVariant {
    const variant = PlatformVariantSchema.parse(variantInput);
    this.database.prepare(`
      INSERT INTO platform_variants (
        id, revision_id, platform, content_kind, fields_json, media_manifest_json,
        variant_hash, created_at, updated_at, title, body_markdown
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        fields_json = excluded.fields_json,
        media_manifest_json = excluded.media_manifest_json,
        variant_hash = excluded.variant_hash,
        updated_at = excluded.updated_at,
        title = excluded.title,
        body_markdown = excluded.body_markdown
    `).run(
      variant.id,
      variant.revisionId,
      variant.platform,
      this.getRevision(variant.revisionId).kind,
      JSON.stringify(variant.platformFields),
      JSON.stringify(variant.media),
      variant.contentHash,
      variant.createdAt,
      variant.createdAt,
      variant.title,
      variant.bodyMarkdown,
    );
    return variant;
  }

  getVariant(id: string): PlatformVariant | undefined {
    const row = this.database.prepare(`
      SELECT id, revision_id, platform, title, body_markdown, media_manifest_json,
             fields_json, variant_hash, created_at
      FROM platform_variants WHERE id = ?
    `).get(id) as VariantRow | undefined;
    if (row === undefined) return undefined;
    return PlatformVariantSchema.parse({
      id: row.id,
      revisionId: row.revision_id,
      platform: row.platform,
      title: row.title,
      bodyMarkdown: row.body_markdown,
      media: JSON.parse(row.media_manifest_json) as unknown,
      platformFields: JSON.parse(row.fields_json) as unknown,
      contentHash: row.variant_hash,
      createdAt: row.created_at,
    });
  }

  listVariants(revisionId: string): PlatformVariant[] {
    const rows = this.database.prepare(`
      SELECT id, revision_id, platform, title, body_markdown, media_manifest_json,
             fields_json, variant_hash, created_at
      FROM platform_variants
      WHERE revision_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(revisionId) as VariantRow[];
    return rows.map((row) => PlatformVariantSchema.parse({
      id: row.id,
      revisionId: row.revision_id,
      platform: row.platform,
      title: row.title,
      bodyMarkdown: row.body_markdown,
      media: JSON.parse(row.media_manifest_json) as unknown,
      platformFields: JSON.parse(row.fields_json) as unknown,
      contentHash: row.variant_hash,
      createdAt: row.created_at,
    }));
  }

  createPlan(input: CreateStoredPlanInput): StoredPublicationPlan {
    const now = this.now().toISOString();
    const plan = createPublishPlan({
      id: this.createId(),
      revision: input.revision,
      variants: input.variants,
      targets: input.targets,
      createdAt: now,
    });

    const jobs = input.targets.map((target): PublishJob => {
      const variant = input.variants.find((entry) => entry.platform === target.platform);
      const targetContentHash = Sha256Schema.safeParse(
        target.platformFields.__omniPostContentHash,
      );
      return PublishJobSchema.parse({
        id: this.createId(),
        planId: plan.id,
        revisionId: plan.revisionId,
        variantId: variant?.id ?? null,
        accountId: target.accountId,
        platform: target.platform,
        deliveryMode: target.deliveryMode,
        state: 'AWAITING_APPROVAL',
        idempotencyKey: createPublishIdempotencyKey({
          accountId: target.accountId,
          platform: target.platform,
          deliveryMode: target.deliveryMode,
          contentHash: targetContentHash.success
            ? targetContentHash.data
            : plan.contentHash,
          scheduledAt: target.scheduledAt,
          platformFields: target.platformFields,
        }),
        scheduledAt: target.scheduledAt,
        attemptCount: 0,
        remotePublicationId: null,
        statusMessage: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    this.database.transaction(() => {
      const scheduledTimes = input.targets
        .map((target) => target.scheduledAt)
        .filter((value): value is string => value !== null)
        .sort();
      this.database.prepare(`
        INSERT INTO publish_plans (
          id, revision_id, scheduled_at, timezone, approval_hash, approved_at,
          created_at, updated_at, variant_ids_json, targets_json, content_hash, approved_by
        ) VALUES (?, ?, ?, 'Asia/Shanghai', NULL, NULL, ?, ?, ?, ?, ?, NULL)
      `).run(
        plan.id,
        plan.revisionId,
        scheduledTimes[0] ?? null,
        now,
        now,
        JSON.stringify(plan.variantIds),
        JSON.stringify(plan.targets),
        plan.contentHash,
      );
      const statement = this.database.prepare(`
        INSERT INTO publish_jobs (
          id, plan_id, account_id, platform, variant_id, state, idempotency_key,
          scheduled_at, created_at, updated_at, revision_id, delivery_mode,
          attempt_count, remote_publication_id, status_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `);
      for (const job of jobs) {
        statement.run(
          job.id,
          job.planId,
          job.accountId,
          job.platform,
          job.variantId,
          job.state,
          job.idempotencyKey,
          job.scheduledAt,
          job.createdAt,
          job.updatedAt,
          job.revisionId,
          job.deliveryMode,
          job.attemptCount,
        );
      }
    })();

    return { plan, jobs };
  }

  approve(planId: string, approvedBy: string): StoredPublicationPlan {
    return this.database.transaction(() => {
      const persisted = this.getPlan(planId);
      const revision = this.getRevision(persisted.revisionId);
      const currentRevisionId = this.database.prepare(`
        SELECT current_revision_id
        FROM content_items
        WHERE id = ?
      `).pluck().get(revision.contentItemId) as string | null | undefined;
      if (currentRevisionId !== persisted.revisionId) {
        throw new Error('发布计划不是内容的当前版本，必须重新创建发布计划');
      }
      const variants = persisted.variantIds.map((id) => {
        const variant = this.getVariant(id);
        if (variant === undefined) throw new Error(`Unknown platform variant: ${id}`);
        return variant;
      });
      const refreshed = createPublishPlan({
        id: persisted.id,
        revision,
        variants,
        targets: persisted.targets.map((target) => ({
          accountId: target.accountId,
          platform: target.platform,
          deliveryMode: target.deliveryMode,
          scheduledAt: target.scheduledAt,
          platformFields: JSON.parse(JSON.stringify(target.platformFields)) as PublishTarget['platformFields'],
        })),
        createdAt: persisted.createdAt,
      });
      if (refreshed.contentHash !== persisted.contentHash) {
        throw new Error('内容已变化，必须重新生成平台版本并再次批准');
      }
      const approved = approvePublishPlan(persisted, {
        approvedBy,
        approvedAt: this.now().toISOString(),
      });
      this.database.prepare(`
        UPDATE publish_plans
        SET approval_hash = ?, approved_by = ?, approved_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        approved.approval?.contentHash,
        approved.approval?.approvedBy,
        approved.approval?.approvedAt,
        approved.updatedAt,
        approved.id,
      );
      this.database.prepare(`
        UPDATE publish_jobs
        SET state = CASE WHEN scheduled_at IS NULL THEN 'APPROVED' ELSE 'SCHEDULED' END,
            updated_at = ?, status_message = NULL
        WHERE plan_id = ? AND state = 'AWAITING_APPROVAL'
      `).run(approved.updatedAt, approved.id);
      return { plan: approved, jobs: this.listJobs(approved.id) };
    })();
  }

  getPlan(id: string): PublishPlan {
    const row = this.database.prepare(`
      SELECT id, revision_id, variant_ids_json, targets_json, content_hash,
             approval_hash, approved_by, approved_at, created_at, updated_at
      FROM publish_plans WHERE id = ?
    `).get(id) as PlanRow | undefined;
    if (row === undefined) throw new Error(`Unknown publish plan: ${id}`);
    return PublishPlanSchema.parse({
      id: row.id,
      revisionId: row.revision_id,
      variantIds: JSON.parse(row.variant_ids_json) as unknown,
      targets: JSON.parse(row.targets_json) as unknown,
      contentHash: row.content_hash,
      approval: row.approval_hash === null ? null : {
        contentHash: row.approval_hash,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  listJobs(planId?: string): PublishJob[] {
    const rows = (planId === undefined
      ? this.database.prepare('SELECT * FROM publish_jobs ORDER BY created_at, rowid').all()
      : this.database.prepare('SELECT * FROM publish_jobs WHERE plan_id = ? ORDER BY created_at, rowid').all(planId)
    ) as JobRow[];
    return rows.map((row) => PublishJobSchema.parse({
      id: row.id,
      planId: row.plan_id,
      revisionId: row.revision_id,
      variantId: row.variant_id,
      accountId: row.account_id,
      platform: row.platform,
      deliveryMode: row.delivery_mode,
      state: row.state,
      idempotencyKey: row.idempotency_key,
      scheduledAt: row.scheduled_at,
      attemptCount: row.attempt_count,
      remotePublicationId: row.remote_publication_id,
      statusMessage: row.status_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private getRevision(id: string): ContentRevision {
    const row = this.database.prepare(`
      SELECT id, item_id, revision_number, kind, title, body_markdown,
             media_manifest_json, source_hash, content_hash, created_at
      FROM content_revisions WHERE id = ?
    `).get(id) as RevisionRow | undefined;
    if (row === undefined) throw new Error(`Unknown content revision: ${id}`);
    return ContentRevisionSchema.parse({
      id: row.id,
      contentItemId: row.item_id,
      revisionNumber: row.revision_number,
      kind: row.kind,
      title: row.title,
      bodyMarkdown: row.body_markdown,
      media: JSON.parse(row.media_manifest_json) as unknown,
      sourceHash: row.source_hash,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    });
  }
}
