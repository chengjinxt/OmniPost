import { describe, expect, it } from 'vitest';

import {
  DeliveryMode,
  JobState,
  canTransitionJobState,
  transitionPublishJob,
  type PublishJob,
} from './index.js';

const NOW = '2026-10-12T02:00:00.000Z';

const createJob = (overrides: Partial<PublishJob> = {}): PublishJob => ({
  id: 'job-1',
  planId: 'plan-1',
  revisionId: 'revision-1',
  variantId: 'variant-1',
  accountId: 'account-1',
  platform: 'wechat',
  deliveryMode: DeliveryMode.DIRECT_API,
  state: JobState.DRAFT,
  idempotencyKey: `publish_${'a'.repeat(64)}`,
  scheduledAt: null,
  attemptCount: 0,
  remotePublicationId: null,
  statusMessage: null,
  createdAt: '2026-10-12T01:00:00.000Z',
  updatedAt: '2026-10-12T01:00:00.000Z',
  ...overrides,
});

describe('job state transitions', () => {
  it.each([
    [JobState.DRAFT, JobState.AWAITING_APPROVAL],
    [JobState.AWAITING_APPROVAL, JobState.APPROVED],
    [JobState.APPROVED, JobState.SCHEDULED],
    [JobState.APPROVED, JobState.PREPARING],
    [JobState.SCHEDULED, JobState.PREPARING],
    [JobState.PREPARING, JobState.SUBMITTED],
    [JobState.SUBMITTED, JobState.PROCESSING],
    [JobState.SUBMITTED, JobState.PUBLISHED],
    [JobState.PROCESSING, JobState.PUBLISHED],
    [JobState.PROCESSING, JobState.REJECTED],
    [JobState.UNKNOWN, JobState.NEEDS_ACTION],
    [JobState.NEEDS_ACTION, JobState.PREPARING],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionJobState(from, to)).toBe(true);
  });

  it.each([
    [JobState.AWAITING_APPROVAL, JobState.REJECTED],
    [JobState.DRAFT, JobState.PUBLISHED],
    [JobState.PREPARING, JobState.APPROVED],
    [JobState.PUBLISHED, JobState.PREPARING],
    [JobState.REJECTED, JobState.DRAFT],
    [JobState.CANCELLED, JobState.DRAFT],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionJobState(from, to)).toBe(false);
    expect(() =>
      transitionPublishJob(createJob({ state: from }), to, {
        now: NOW,
      }),
    ).toThrow(`Illegal PublishJob transition: ${from} -> ${to}`);
  });

  it('moves an overdue scheduled job to NEEDS_ACTION', () => {
    const job = createJob({
      state: JobState.SCHEDULED,
      scheduledAt: '2026-10-12T01:59:59.000Z',
    });

    const next = transitionPublishJob(job, JobState.NEEDS_ACTION, {
      now: NOW,
      reason: 'Missed scheduled publish window',
    });

    expect(next.state).toBe(JobState.NEEDS_ACTION);
    expect(next.statusMessage).toBe('Missed scheduled publish window');
    expect(job.state).toBe(JobState.SCHEDULED);
  });

  it('does not mark a future scheduled job as overdue', () => {
    const job = createJob({
      state: JobState.SCHEDULED,
      scheduledAt: '2026-10-12T02:00:01.000Z',
    });

    expect(() =>
      transitionPublishJob(job, JobState.NEEDS_ACTION, {
        now: NOW,
        reason: 'Too early',
      }),
    ).toThrow('A scheduled job can enter NEEDS_ACTION only after its scheduled time');
  });

  it('allows only an explicit manual retry from FAILED and preserves the idempotency key', () => {
    const failed = createJob({ state: JobState.FAILED, attemptCount: 1 });

    expect(() =>
      transitionPublishJob(failed, JobState.PREPARING, {
        now: NOW,
      }),
    ).toThrow('FAILED jobs require an explicit manual retry');

    const retried = transitionPublishJob(failed, JobState.PREPARING, {
      now: NOW,
      manualRetry: true,
    });

    expect(retried.idempotencyKey).toBe(failed.idempotencyKey);
    expect(retried.attemptCount).toBe(2);
  });
});
