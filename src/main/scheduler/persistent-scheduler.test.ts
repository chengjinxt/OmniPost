import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ContentKind,
  DeliveryMode,
  type AccountCapabilities,
  type AssistedSession,
  type PlatformAdapter,
  type PreparedPublication,
  type PublishTarget,
  type RemotePublicationStatus,
  type SubmissionReceipt,
  type ValidationIssue,
} from '../../domain/index.js';
import { openDatabase } from '../infrastructure/database.js';
import { PersistentJobQueue } from '../infrastructure/job-queue.js';
import {
  PersistentSchedulerService,
  type AdapterRegistry,
  type NotificationPort,
  type SchedulerNotification,
} from './persistent-scheduler.js';

const now = new Date('2026-10-12T08:00:00.000Z');
const timestamp = now.toISOString();
const hash = 'a'.repeat(64);

interface JobRecord {
  state: string;
  attempt_count: number;
  remote_publication_id: string | null;
  status_message: string | null;
}

interface AttemptRecord {
  state: string;
  receipt_id: string | null;
  receipt_json: string | null;
  finished_at: string | null;
}

class FakeAdapter implements PlatformAdapter {
  readonly events: string[] = [];
  readonly preparedTargets = new Map<string, PublishTarget>();
  submitBehavior: 'success' | 'never' | 'error' = 'success';
  pollBehavior: 'success' | 'never' = 'success';
  pollResults: Array<RemotePublicationStatus | Error> = [];

  async probeCapabilities(accountId: string): Promise<AccountCapabilities> {
    return {
      accountId,
      platform: 'TEST',
      deliveryModes: [DeliveryMode.DIRECT_API],
      contentKinds: [ContentKind.ARTICLE],
      features: { supportsDrafts: true, supportsScheduling: true, supportsRemoteStatus: true },
      qualifications: [],
      scopes: [],
      probes: [],
      checkedAt: timestamp,
    };
  }

  async validate(_revisionId: string, _target: PublishTarget): Promise<ValidationIssue[]> {
    return [];
  }

  async prepare(revisionId: string, target: PublishTarget): Promise<PreparedPublication> {
    this.events.push('prepare');
    const prepared = {
      id: `prepared-${revisionId}`,
      revisionId,
      target,
      contentHash: hash,
      idempotencyKey: `publish_${hash}`,
      createdAt: timestamp,
    };
    this.preparedTargets.set(prepared.id, target);
    return prepared;
  }

  async submit(preparedId: string): Promise<SubmissionReceipt> {
    this.events.push('submit');
    if (this.submitBehavior === 'never') return new Promise(() => undefined);
    if (this.submitBehavior === 'error') throw new Error('uncertain submit result');
    const target = this.preparedTargets.get(preparedId);
    if (!target) throw new Error(`Missing prepared target: ${preparedId}`);
    return {
      id: `receipt-${preparedId}`,
      preparedId,
      platform: 'TEST',
      accountId: target.accountId,
      deliveryMode: target.deliveryMode,
      idempotencyKey: `publish_${hash}`,
      remoteId: `remote-${preparedId}`,
      status: null,
      submittedAt: timestamp,
    };
  }

  async poll(receipt: SubmissionReceipt): Promise<RemotePublicationStatus> {
    this.events.push('poll');
    if (this.pollBehavior === 'never') return new Promise(() => undefined);
    const next = this.pollResults.shift() ?? remoteStatus('PUBLISHED', receipt.remoteId);
    if (next instanceof Error) throw next;
    return next;
  }

  async openAssistedFlow(preparedId: string): Promise<AssistedSession> {
    this.events.push('open-assisted');
    return {
      id: `session-${preparedId}`,
      preparedId,
      status: 'OPEN',
      openedAt: timestamp,
    };
  }
}

class FakeRegistry implements AdapterRegistry {
  constructor(private readonly adapter?: PlatformAdapter) {}

  get(_platform: string): PlatformAdapter | undefined {
    return this.adapter;
  }
}

class RecordingNotifications implements NotificationPort {
  readonly messages: SchedulerNotification[] = [];

  async notify(message: SchedulerNotification): Promise<void> {
    this.messages.push(message);
  }
}

function remoteStatus(
  state: RemotePublicationStatus['state'],
  remoteId: string | null = 'remote-1',
): RemotePublicationStatus {
  return {
    state,
    remoteId,
    url: state === 'PUBLISHED' ? 'https://example.invalid/publication' : null,
    message: state === 'PUBLISHED' ? null : `${state} status`,
    checkedAt: timestamp,
  };
}

describe('PersistentSchedulerService', () => {
  let database: BetterSqlite3.Database;
  let notifications: RecordingNotifications;

  beforeEach(() => {
    database = openDatabase(':memory:');
    notifications = new RecordingNotifications();
  });

  afterEach(() => database.close());

  it.each([
    [DeliveryMode.DIRECT_API, 'PUBLISHED'],
    [DeliveryMode.REMOTE_DRAFT, 'NEEDS_ACTION'],
  ] as const)('prepares, submits, polls and persists a %s job', async (deliveryMode, finalState) => {
    seedJob(database, { id: 'job-1', deliveryMode });
    const adapter = new FakeAdapter();
    adapter.pollResults.push(remoteStatus(finalState));
    const scheduler = createScheduler(database, adapter, notifications);

    const result = await scheduler.runNext();

    expect(result).toEqual({ action: 'EXECUTED', jobId: 'job-1', state: finalState });
    expect(adapter.events).toEqual(['prepare', 'submit', 'poll']);
    expect(readJob(database, 'job-1')).toMatchObject({
      state: finalState,
      attempt_count: 1,
      remote_publication_id: 'remote-1',
    });
    expect(readAttempts(database, 'job-1')).toEqual([
      expect.objectContaining({ state: finalState, receipt_id: 'receipt-prepared-revision-job-1' }),
    ]);
  });

  it('notifies and opens an assisted flow at the scheduled time without automatic submission', async () => {
    seedJob(database, {
      id: 'job-assisted',
      deliveryMode: DeliveryMode.ASSISTED_BROWSER,
      state: 'SCHEDULED',
      scheduledAt: timestamp,
    });
    const adapter = new FakeAdapter();
    const scheduler = createScheduler(database, adapter, notifications);

    const result = await scheduler.runNext();

    expect(result).toEqual({ action: 'EXECUTED', jobId: 'job-assisted', state: 'NEEDS_ACTION' });
    expect(adapter.events).toEqual(['prepare', 'open-assisted']);
    expect(notifications.messages).toEqual([
      expect.objectContaining({ jobId: 'job-assisted', kind: 'ASSISTED_BROWSER_READY' }),
    ]);
    expect(readJob(database, 'job-assisted').state).toBe('NEEDS_ACTION');
    expect(readAttempts(database, 'job-assisted')).toEqual([
      expect.objectContaining({ state: 'NEEDS_ACTION', receipt_id: null }),
    ]);
  });

  it.each([DeliveryMode.MANUAL_HANDOFF, DeliveryMode.UNSUPPORTED] as const)(
    'moves %s jobs to NEEDS_ACTION without invoking a platform adapter',
    async (deliveryMode) => {
      seedJob(database, { id: `job-${deliveryMode}`, deliveryMode });
      const adapter = new FakeAdapter();
      const scheduler = createScheduler(database, adapter, notifications);

      await scheduler.runNext();

      expect(adapter.events).toEqual([]);
      expect(readJob(database, `job-${deliveryMode}`).state).toBe('NEEDS_ACTION');
      expect(readAttempts(database, `job-${deliveryMode}`)).toEqual([
        expect.objectContaining({ state: 'NEEDS_ACTION', receipt_id: null }),
      ]);
    },
  );

  it('marks a timed-out submit UNKNOWN and never blindly submits the same job again', async () => {
    seedJob(database, { id: 'job-timeout', deliveryMode: DeliveryMode.DIRECT_API });
    const adapter = new FakeAdapter();
    adapter.submitBehavior = 'never';
    const scheduler = createScheduler(database, adapter, notifications, 5);

    const first = await scheduler.runNext();
    adapter.submitBehavior = 'success';
    const second = await scheduler.runNext();

    expect(first).toEqual({ action: 'EXECUTED', jobId: 'job-timeout', state: 'UNKNOWN' });
    expect(second).toBeNull();
    expect(adapter.events).toEqual(['prepare', 'submit']);
    expect(readJob(database, 'job-timeout')).toMatchObject({ state: 'UNKNOWN', attempt_count: 1 });
    expect(readAttempts(database, 'job-timeout')).toHaveLength(1);
    expect(notifications.messages).toContainEqual(
      expect.objectContaining({ jobId: 'job-timeout', kind: 'SUBMISSION_UNKNOWN' }),
    );
  });

  it('bounds remote status polling and leaves the receipt recoverable', async () => {
    seedJob(database, { id: 'job-poll-timeout', deliveryMode: DeliveryMode.DIRECT_API });
    const adapter = new FakeAdapter();
    adapter.pollBehavior = 'never';
    const scheduler = createScheduler(database, adapter, notifications, 5);

    const result = await scheduler.runNext();

    expect(result).toEqual({
      action: 'EXECUTED',
      jobId: 'job-poll-timeout',
      state: 'UNKNOWN',
    });
    expect(readJob(database, 'job-poll-timeout')).toMatchObject({
      state: 'UNKNOWN',
      remote_publication_id: 'remote-prepared-revision-job-poll-timeout',
    });
    expect(readAttempts(database, 'job-poll-timeout')[0]?.receipt_json)
      .toContain('receipt-prepared-revision-job-poll-timeout');
  });

  it('polls an UNKNOWN receipt and still claims new work without repeating submit', async () => {
    seedJob(database, { id: 'job-1', deliveryMode: DeliveryMode.DIRECT_API });
    seedJob(database, {
      id: 'job-2',
      accountId: 'account-job-2',
      deliveryMode: DeliveryMode.DIRECT_API,
    });
    const adapter = new FakeAdapter();
    adapter.pollResults.push(new Error('remote status unavailable'), remoteStatus('PUBLISHED'));
    const scheduler = createScheduler(database, adapter, notifications);

    const uncertain = await scheduler.runNext();
    const recovered = await scheduler.runNext();

    expect(uncertain).toEqual({ action: 'EXECUTED', jobId: 'job-1', state: 'UNKNOWN' });
    expect(recovered).toEqual({ action: 'EXECUTED', jobId: 'job-2', state: 'PUBLISHED' });
    expect(adapter.events).toEqual([
      'prepare', 'submit', 'poll', 'poll', 'prepare', 'submit', 'poll',
    ]);
    expect(readJob(database, 'job-1').state).toBe('PUBLISHED');
    expect(readJob(database, 'job-2').state).toBe('PUBLISHED');
    expect(readAttempts(database, 'job-1')).toEqual([
      expect.objectContaining({ state: 'PUBLISHED', finished_at: timestamp }),
    ]);
  });

  it('continues with one due job when polling a persisted UNKNOWN receipt still fails', async () => {
    seedJob(database, { id: 'job-a-unknown', deliveryMode: DeliveryMode.DIRECT_API });
    seedJob(database, {
      id: 'job-z-due',
      accountId: 'account-job-z-due',
      deliveryMode: DeliveryMode.DIRECT_API,
    });
    const adapter = new FakeAdapter();
    adapter.pollResults.push(
      new Error('initial status unavailable'),
      new Error('persisted status still unavailable'),
      remoteStatus('PUBLISHED', 'remote-job-due'),
    );
    const scheduler = createScheduler(database, adapter, notifications);

    expect(await scheduler.runNext()).toEqual({
      action: 'EXECUTED',
      jobId: 'job-a-unknown',
      state: 'UNKNOWN',
    });

    expect(await scheduler.runNext()).toEqual({
      action: 'EXECUTED',
      jobId: 'job-z-due',
      state: 'PUBLISHED',
    });
    expect(readJob(database, 'job-a-unknown').state).toBe('UNKNOWN');
    expect(readJob(database, 'job-z-due').state).toBe('PUBLISHED');
    expect(adapter.events).toEqual([
      'prepare',
      'submit',
      'poll',
      'poll',
      'prepare',
      'submit',
      'poll',
    ]);
  });

  it('does not let a long-running remote publication starve due jobs', async () => {
    seedJob(database, { id: 'job-a-processing', deliveryMode: DeliveryMode.DIRECT_API });
    seedJob(database, {
      id: 'job-z-due',
      accountId: 'account-job-z-due',
      deliveryMode: DeliveryMode.DIRECT_API,
    });
    const adapter = new FakeAdapter();
    adapter.pollResults.push(
      remoteStatus('PROCESSING', 'remote-processing'),
      remoteStatus('PROCESSING', 'remote-processing'),
      remoteStatus('PUBLISHED', 'remote-due'),
    );
    const scheduler = createScheduler(database, adapter, notifications);

    expect(await scheduler.runNext()).toEqual({
      action: 'EXECUTED',
      jobId: 'job-a-processing',
      state: 'PROCESSING',
    });
    expect(await scheduler.runNext()).toEqual({
      action: 'EXECUTED',
      jobId: 'job-z-due',
      state: 'PUBLISHED',
    });
    expect(readJob(database, 'job-a-processing').state).toBe('PROCESSING');
    expect(readJob(database, 'job-z-due').state).toBe('PUBLISHED');
  });
});

function createScheduler(
  database: BetterSqlite3.Database,
  adapter: PlatformAdapter,
  notifications: NotificationPort,
  submitTimeoutMs = 1_000,
): PersistentSchedulerService {
  let nextId = 0;
  return new PersistentSchedulerService({
    database,
    queue: new PersistentJobQueue(database),
    adapters: new FakeRegistry(adapter),
    notifications,
    workerId: 'worker-1',
    leaseDurationMs: 60_000,
    submitTimeoutMs,
    createId: () => `attempt-${++nextId}`,
    now: () => now,
  });
}

function seedJob(
  database: BetterSqlite3.Database,
  input: {
    id: string;
    deliveryMode: (typeof DeliveryMode)[keyof typeof DeliveryMode];
    accountId?: string;
    state?: 'APPROVED' | 'SCHEDULED';
    scheduledAt?: string | null;
  },
): void {
  const accountId = input.accountId ?? `account-${input.id}`;
  const itemId = `item-${input.id}`;
  const revisionId = `revision-${input.id}`;
  const planId = `plan-${input.id}`;
  const target: PublishTarget = {
    accountId,
    platform: 'TEST',
    deliveryMode: input.deliveryMode,
    scheduledAt: input.scheduledAt ?? null,
    platformFields: { anonymous: true },
  };
  database.prepare(`
    INSERT INTO account_connections (
      id, platform, display_name, credential_ref, capabilities_json, status,
      created_at, updated_at, delivery_mode
    ) VALUES (?, 'TEST', ?, NULL, '{}', 'CONNECTED', ?, ?, ?)
  `).run(accountId, accountId, timestamp, timestamp, input.deliveryMode);
  database.prepare(`
    INSERT INTO content_items (
      id, title, kind, source_type, created_at, updated_at, current_revision_id, source_json
    ) VALUES (?, ?, 'ARTICLE', 'TEST', ?, ?, NULL, NULL)
  `).run(itemId, input.id, timestamp, timestamp);
  database.prepare(`
    INSERT INTO content_revisions (
      id, item_id, revision_number, title, body_markdown, body_html,
      media_manifest_json, source_metadata_json, content_hash, created_at, kind, source_hash
    ) VALUES (?, ?, 1, ?, 'body', '', '[]', '{}', ?, ?, 'ARTICLE', NULL)
  `).run(revisionId, itemId, input.id, hash, timestamp);
  database.prepare('UPDATE content_items SET current_revision_id = ? WHERE id = ?')
    .run(revisionId, itemId);
  database.prepare(`
    INSERT INTO publish_plans (
      id, revision_id, scheduled_at, timezone, approval_hash, approved_at,
      created_at, updated_at, variant_ids_json, targets_json, content_hash, approved_by
    ) VALUES (?, ?, ?, 'Asia/Shanghai', ?, ?, ?, ?, '[]', ?, ?, 'tester')
  `).run(
    planId,
    revisionId,
    target.scheduledAt,
    hash,
    timestamp,
    timestamp,
    timestamp,
    JSON.stringify([target]),
    hash,
  );
  database.prepare(`
    INSERT INTO publish_jobs (
      id, plan_id, account_id, platform, variant_id, state, idempotency_key,
      scheduled_at, created_at, updated_at, revision_id, delivery_mode,
      attempt_count, remote_publication_id, status_message
    ) VALUES (?, ?, ?, 'TEST', NULL, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
  `).run(
    input.id,
    planId,
    accountId,
    input.state ?? 'APPROVED',
    `publish_${input.id.padEnd(64, '0').slice(0, 64)}`,
    target.scheduledAt,
    timestamp,
    timestamp,
    revisionId,
    input.deliveryMode,
  );
}

function readJob(database: BetterSqlite3.Database, id: string): JobRecord {
  return database.prepare(`
    SELECT state, attempt_count, remote_publication_id, status_message
    FROM publish_jobs WHERE id = ?
  `).get(id) as JobRecord;
}

function readAttempts(database: BetterSqlite3.Database, jobId: string): AttemptRecord[] {
  return database.prepare(`
    SELECT state, receipt_id, receipt_json, finished_at
    FROM publish_attempts WHERE job_id = ? ORDER BY attempt_number
  `).all(jobId) as AttemptRecord[];
}
