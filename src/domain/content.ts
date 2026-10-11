import { z } from 'zod';

import {
  ContentRevisionInputSchema,
  ContentRevisionSchema,
  PlatformVariantInputSchema,
  PlatformVariantSchema,
  PublishPlanSchema,
  PublishTargetSchema,
  type ContentRevision,
  type CreateContentRevisionInput,
  type CreatePlatformVariantInput,
  type PlatformVariant,
  type PublishPlan,
  type PublishTarget,
  type RevisionMedia,
} from './entities.js';
import {
  DeliveryModeSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  Sha256Schema,
  deepFreeze,
  hashCanonicalJson,
  type ContentKind,
  type JsonValue,
} from './primitives.js';

const contentRevisionHash = (revision: {
  kind: ContentKind;
  title: string;
  bodyMarkdown: string;
  media: readonly RevisionMedia[];
}): string =>
  hashCanonicalJson({
    kind: revision.kind,
    title: revision.title,
    bodyMarkdown: revision.bodyMarkdown,
    media: revision.media.map((entry) => ({
      assetId: entry.assetId,
      sha256: entry.sha256,
      order: entry.order,
    })),
  });

export const createContentRevision = (
  input: CreateContentRevisionInput,
): ContentRevision => {
  const parsed = ContentRevisionInputSchema.parse(input);
  return deepFreeze(
    ContentRevisionSchema.parse({
      ...parsed,
      contentHash: contentRevisionHash(parsed),
    }),
  );
};

export type NextContentRevisionInput = {
  id: string;
  createdAt: string;
  kind?: ContentKind;
  title?: string;
  bodyMarkdown?: string;
  media?: RevisionMedia[];
  sourceHash?: string | null;
};

export const createNextContentRevision = (
  current: ContentRevision,
  input: NextContentRevisionInput,
): ContentRevision => {
  if (input.id === current.id) {
    throw new Error('A new ContentRevision must have a new id');
  }

  return createContentRevision({
    id: input.id,
    contentItemId: current.contentItemId,
    revisionNumber: current.revisionNumber + 1,
    kind: input.kind ?? current.kind,
    title: input.title ?? current.title,
    bodyMarkdown: input.bodyMarkdown ?? current.bodyMarkdown,
    media: input.media ? [...input.media] : current.media.map((entry) => ({ ...entry })),
    sourceHash: input.sourceHash === undefined ? current.sourceHash : input.sourceHash,
    createdAt: input.createdAt,
  });
};

const platformVariantHash = (variant: {
  platform: string;
  title: string | null;
  bodyMarkdown: string | null;
  media: readonly RevisionMedia[] | null;
  platformFields: Readonly<Record<string, JsonValue>>;
}): string =>
  hashCanonicalJson({
    platform: variant.platform,
    title: variant.title,
    bodyMarkdown: variant.bodyMarkdown,
    media:
      variant.media?.map((entry) => ({
        assetId: entry.assetId,
        sha256: entry.sha256,
        order: entry.order,
      })) ?? null,
    platformFields: variant.platformFields,
  });

export const createPlatformVariant = (
  input: CreatePlatformVariantInput,
): PlatformVariant => {
  const parsed = PlatformVariantInputSchema.parse(input);
  return deepFreeze(
    PlatformVariantSchema.parse({
      ...parsed,
      contentHash: platformVariantHash(parsed),
    }),
  );
};

const publishPlanContentHash = (
  revision: ContentRevision,
  variants: readonly PlatformVariant[],
  targets: readonly PublishTarget[],
): string =>
  hashCanonicalJson({
    revisionHash: revision.contentHash,
    variants: variants
      .map((variant) => ({ platform: variant.platform, contentHash: variant.contentHash }))
      .sort((left, right) => {
        const platformOrder = left.platform.localeCompare(right.platform);
        return platformOrder || left.contentHash.localeCompare(right.contentHash);
      }),
    targets: targets
      .map((target) => ({
        accountId: target.accountId,
        platform: target.platform,
        deliveryMode: target.deliveryMode,
        scheduledAt: target.scheduledAt,
        platformFields: target.platformFields,
      }))
      .sort((left, right) =>
        hashCanonicalJson(left).localeCompare(hashCanonicalJson(right)),
      ),
  });

const assertVariantsBelongToRevision = (
  revision: ContentRevision,
  variants: readonly PlatformVariant[],
): void => {
  const mismatched = variants.find((variant) => variant.revisionId !== revision.id);
  if (mismatched) {
    throw new Error(
      `PlatformVariant ${mismatched.id} belongs to ${mismatched.revisionId}, not ${revision.id}`,
    );
  }
};

export type CreatePublishPlanInput = {
  id: string;
  revision: ContentRevision;
  variants: readonly PlatformVariant[];
  targets: readonly PublishTarget[];
  createdAt: string;
};

export const createPublishPlan = (input: CreatePublishPlanInput): PublishPlan => {
  assertVariantsBelongToRevision(input.revision, input.variants);
  const targets = input.targets.map((target) => PublishTargetSchema.parse(target));
  const contentHash = publishPlanContentHash(input.revision, input.variants, targets);

  return deepFreeze(
    PublishPlanSchema.parse({
      id: input.id,
      revisionId: input.revision.id,
      variantIds: input.variants.map((variant) => variant.id),
      targets,
      contentHash,
      approval: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }),
  );
};

const ApprovalInputSchema = z
  .object({
    approvedBy: EntityIdSchema,
    approvedAt: IsoDateTimeSchema,
  })
  .strict();

export const approvePublishPlan = (
  plan: PublishPlan,
  input: z.input<typeof ApprovalInputSchema>,
): PublishPlan => {
  const approval = ApprovalInputSchema.parse(input);
  return deepFreeze(
    PublishPlanSchema.parse({
      ...plan,
      approval: {
        contentHash: plan.contentHash,
        ...approval,
      },
      updatedAt: approval.approvedAt,
    }),
  );
};

export const isPublishPlanApprovalValid = (plan: PublishPlan): boolean =>
  plan.approval !== null && plan.approval.contentHash === plan.contentHash;

export const refreshPublishPlanContent = (
  plan: PublishPlan,
  revision: ContentRevision,
  variants: readonly PlatformVariant[],
  updatedAt: string,
): PublishPlan => {
  assertVariantsBelongToRevision(revision, variants);
  const targets = plan.targets.map((target) => PublishTargetSchema.parse(target));
  const contentHash = publishPlanContentHash(revision, variants, targets);
  const approval = contentHash === plan.contentHash ? plan.approval : null;

  return deepFreeze(
    PublishPlanSchema.parse({
      ...plan,
      revisionId: revision.id,
      variantIds: variants.map((variant) => variant.id),
      contentHash,
      approval,
      updatedAt,
    }),
  );
};

const PublishIdempotencyInputSchema = z
  .object({
    accountId: EntityIdSchema,
    platform: EntityIdSchema,
    deliveryMode: DeliveryModeSchema,
    contentHash: Sha256Schema,
    scheduledAt: IsoDateTimeSchema.nullable(),
    platformFields: JsonObjectSchema,
  })
  .strict();

export type PublishIdempotencyInput = z.input<typeof PublishIdempotencyInputSchema>;

export const createPublishIdempotencyKey = (input: PublishIdempotencyInput): string => {
  const parsed = PublishIdempotencyInputSchema.parse(input);
  return `publish_${hashCanonicalJson(parsed)}`;
};
