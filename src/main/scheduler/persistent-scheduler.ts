import { randomUUID } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import {
  DeliveryMode,
  DeliveryModeSchema,
  JobState,
  PublishTargetSchema,
  SubmissionReceiptSchema,
  type AssistedSession,
  type JobState as JobStateValue,
  type PlatformAdapter,
  type PreparedPublication,
  type PublishTarget,
  type RemotePublicationStatus,
  type SubmissionReceipt,
} from '../../domain/index.js';
import type { PersistentJobQueue } from '../infrastructure/job-queue.js';
import { runPlatformOperationWithSignal } from '../platforms/adapter-runtime.js';

export interface AdapterRegistry {
  get(platform: string): PlatformAdapter | undefined;
}

export interface SchedulerNotification {
  kind: 'ASSISTED_BROWSER_READY' | 'MANUAL_ACTION_REQUIRED' | 'SUBMISSION_UNKNOWN';
  jobId: string;
  platform: string;
  message: string;
}

export interface NotificationPort {
  notify(notification: SchedulerNotification): Promise<void>;
}

export interface PersistentSchedulerServiceOptions {
  database: BetterSqlite3.Database;
  queue: PersistentJobQueue;
  adapters: AdapterRegistry;
  notifications: NotificationPort;
  workerId: string;
  leaseDurationMs: number;
  submitTimeoutMs: number;
  createId?: () => string;
  now?: () => Date;
}

export interface SchedulerRunResult {
  action: 'EXECUTED' | 'POLLED';
  jobId: string;
  state: JobStateValue;
}

interface JobContextRow {
  id: string;
  account_id: string;
  platform: string;
  state: JobStateValue;
  idempotency_key: string;
  scheduled_at: string | null;
  revision_id: string | null;
  delivery_mode: string;
  attempt_count: number;
  targets_json: string;
}

interface JobContext {
  id: string;
  accountId: string;
  platform: string;
  state: JobStateValue;
  idempotencyKey: string;
  scheduledAt: string | null;
  revisionId: string;
  deliveryMode: (typeof DeliveryMode)[keyof typeof DeliveryMode];
  attemptCount: number;
  target: PublishTarget;
}

interface AttemptRow {
  id: string;
  receipt_json: string | null;
}

interface AttemptEnvelope {
  prepared?: PreparedPublication;
  receipt?: SubmissionReceipt;
  assistedSession?: AssistedSession;
}

class PlatformRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Platform request timed out after ${timeoutMs}ms`);
    this.name = 'PlatformRequestTimeoutError';
  }
}

const isFinishedState = (state: JobStateValue): boolean =>
  state !== JobState.SUBMITTED && state !== JobState.PROCESSING && state !== JobState.UNKNOWN;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new PlatformRequestTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await runPlatformOperationWithSignal(
      controller.signal,
      () => Promise.race([operation(), deadline]),
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort();
  }
}

export class PersistentSchedulerService {
  private readonly database: BetterSqlite3.Database;
  private readonly queue: PersistentJobQueue;
  private readonly adapters: AdapterRegistry;
  private readonly notifications: NotificationPort;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly submitTimeoutMs: number;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(options: PersistentSchedulerServiceOptions) {
    this.database = options.database;
    this.queue = options.queue;
    this.adapters = options.adapters;
    this.notifications = options.notifications;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs;
    this.submitTimeoutMs = options.submitTimeoutMs;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public async runNext(): Promise<SchedulerRunResult | null> {
    const resumed = await this.pollPersistedReceipt();

    const claimed = this.queue.claimNextDue(
      this.workerId,
      this.now(),
      this.leaseDurationMs,
    );
    if (!claimed) return resumed;

    const job = this.loadJob(claimed.id);
    const attemptId = this.beginAttempt(job);
    if (
      job.deliveryMode === DeliveryMode.MANUAL_HANDOFF ||
      job.deliveryMode === DeliveryMode.UNSUPPORTED
    ) {
      const message = `${job.deliveryMode} requires manual action`;
      this.finishClaimedJob(job, attemptId, JobState.NEEDS_ACTION, message, {});
      await this.notifications.notify({
        kind: 'MANUAL_ACTION_REQUIRED',
        jobId: job.id,
        platform: job.platform,
        message,
      });
      return { action: 'EXECUTED', jobId: job.id, state: JobState.NEEDS_ACTION };
    }

    const adapter = this.adapters.get(job.platform);
    if (!adapter) {
      const message = `No platform adapter is registered for ${job.platform}`;
      this.finishClaimedJob(job, attemptId, JobState.NEEDS_ACTION, message, {});
      await this.notifications.notify({
        kind: 'MANUAL_ACTION_REQUIRED',
        jobId: job.id,
        platform: job.platform,
        message,
      });
      return { action: 'EXECUTED', jobId: job.id, state: JobState.NEEDS_ACTION };
    }

    let prepared: PreparedPublication;
    try {
      prepared = await withTimeout(
        () => adapter.prepare(job.revisionId, job.target),
        this.submitTimeoutMs,
      );
      this.updateAttempt(attemptId, JobState.PREPARING, { prepared });
    } catch (error) {
      const message = `Preparation failed: ${errorMessage(error)}`;
      this.finishClaimedJob(job, attemptId, JobState.FAILED, message, {}, 'PREPARE_FAILED');
      return { action: 'EXECUTED', jobId: job.id, state: JobState.FAILED };
    }

    if (job.deliveryMode === DeliveryMode.ASSISTED_BROWSER) {
      const message = 'Assisted browser publication is ready for user confirmation';
      await this.notifications.notify({
        kind: 'ASSISTED_BROWSER_READY',
        jobId: job.id,
        platform: job.platform,
        message,
      });
      let assistedSession: AssistedSession | undefined;
      let statusMessage = message;
      if (adapter.openAssistedFlow) {
        try {
          assistedSession = await withTimeout(
            () => adapter.openAssistedFlow!(prepared.id),
            this.submitTimeoutMs,
          );
        } catch (error) {
          statusMessage = `${message}: ${errorMessage(error)}`;
        }
      } else {
        statusMessage = `${message}: adapter has no assisted flow`;
      }
      this.finishClaimedJob(
        job,
        attemptId,
        JobState.NEEDS_ACTION,
        statusMessage,
        assistedSession ? { prepared, assistedSession } : { prepared },
      );
      return { action: 'EXECUTED', jobId: job.id, state: JobState.NEEDS_ACTION };
    }

    this.markSubmissionStarted(job, attemptId, { prepared });
    let receipt: SubmissionReceipt;
    try {
      receipt = await withTimeout(() => adapter.submit(prepared.id), this.submitTimeoutMs);
      this.persistReceipt(job, attemptId, prepared, receipt);
    } catch (error) {
      const message = errorMessage(error);
      this.finishClaimedJob(
        job,
        attemptId,
        JobState.UNKNOWN,
        message,
        { prepared },
        error instanceof PlatformRequestTimeoutError ? 'SUBMIT_TIMEOUT' : 'SUBMIT_UNCERTAIN',
      );
      await this.notifications.notify({
        kind: 'SUBMISSION_UNKNOWN',
        jobId: job.id,
        platform: job.platform,
        message,
      });
      return { action: 'EXECUTED', jobId: job.id, state: JobState.UNKNOWN };
    }

    if (!adapter.poll) {
      const message = 'Submission receipt exists but remote status lookup is unavailable';
      this.finishClaimedJob(
        job,
        attemptId,
        JobState.UNKNOWN,
        message,
        { prepared, receipt },
        'POLL_UNAVAILABLE',
      );
      await this.notifications.notify({
        kind: 'SUBMISSION_UNKNOWN',
        jobId: job.id,
        platform: job.platform,
        message,
      });
      return { action: 'EXECUTED', jobId: job.id, state: JobState.UNKNOWN };
    }

    try {
      const status = await withTimeout(
        () => adapter.poll!(receipt),
        this.submitTimeoutMs,
      );
      this.applyRemoteStatus(job.id, attemptId, status, { prepared, receipt }, true);
      return { action: 'EXECUTED', jobId: job.id, state: status.state };
    } catch (error) {
      const message = `Remote status is uncertain: ${errorMessage(error)}`;
      this.finishClaimedJob(
        job,
        attemptId,
        JobState.UNKNOWN,
        message,
        { prepared, receipt },
        'POLL_FAILED',
      );
      await this.notifications.notify({
        kind: 'SUBMISSION_UNKNOWN',
        jobId: job.id,
        platform: job.platform,
        message,
      });
      return { action: 'EXECUTED', jobId: job.id, state: JobState.UNKNOWN };
    }
  }

  private async pollPersistedReceipt(): Promise<SchedulerRunResult | null> {
    const jobIds = this.database.prepare(`
      SELECT id
      FROM publish_jobs
      WHERE state IN ('UNKNOWN', 'SUBMITTED', 'PROCESSING')
      ORDER BY CASE state WHEN 'UNKNOWN' THEN 0 WHEN 'SUBMITTED' THEN 1 ELSE 2 END,
               updated_at, id
    `).pluck().all() as string[];

    for (const jobId of jobIds) {
      const attempt = this.latestAttempt(jobId);
      const envelope = this.decodeAttemptEnvelope(attempt?.receipt_json ?? null);
      const receiptResult = SubmissionReceiptSchema.safeParse(envelope.receipt);
      if (!attempt || !receiptResult.success) continue;
      const job = this.loadJob(jobId);
      const adapter = this.adapters.get(job.platform);
      if (!adapter?.poll) continue;
      try {
        const status = await withTimeout(
          () => adapter.poll!(receiptResult.data),
          this.submitTimeoutMs,
        );
        this.applyRemoteStatus(job.id, attempt.id, status, envelope, false);
        return { action: 'POLLED', jobId: job.id, state: status.state };
      } catch (error) {
        const message = `Remote status is uncertain: ${errorMessage(error)}`;
        this.updateUnclaimedJob(job.id, JobState.UNKNOWN, message, receiptResult.data.remoteId);
        this.updateAttempt(
          attempt.id,
          JobState.UNKNOWN,
          envelope,
          'POLL_FAILED',
          message,
          false,
        );
        return { action: 'POLLED', jobId: job.id, state: JobState.UNKNOWN };
      }
    }
    return null;
  }

  private loadJob(jobId: string): JobContext {
    const row = this.database.prepare(`
      SELECT jobs.id, jobs.account_id, jobs.platform, jobs.state, jobs.idempotency_key,
             jobs.scheduled_at, jobs.revision_id, jobs.delivery_mode, jobs.attempt_count,
             plans.targets_json
      FROM publish_jobs AS jobs
      JOIN publish_plans AS plans ON plans.id = jobs.plan_id
      WHERE jobs.id = ?
    `).get(jobId) as JobContextRow | undefined;
    if (!row || !row.revision_id) throw new Error(`Publish job context is incomplete: ${jobId}`);
    const deliveryMode = DeliveryModeSchema.parse(row.delivery_mode);
    const rawTargets = JSON.parse(row.targets_json) as unknown;
    if (!Array.isArray(rawTargets)) throw new Error(`Publish plan targets are invalid: ${jobId}`);
    const targets = rawTargets.map((target) => PublishTargetSchema.parse(target));
    const target = targets.find(
      (entry) =>
        entry.accountId === row.account_id &&
        entry.platform === row.platform &&
        entry.deliveryMode === deliveryMode &&
        entry.scheduledAt === row.scheduled_at,
    );
    if (!target) throw new Error(`Publish target is missing for job: ${jobId}`);
    return {
      id: row.id,
      accountId: row.account_id,
      platform: row.platform,
      state: row.state,
      idempotencyKey: row.idempotency_key,
      scheduledAt: row.scheduled_at,
      revisionId: row.revision_id,
      deliveryMode,
      attemptCount: row.attempt_count,
      target,
    };
  }

  private beginAttempt(job: JobContext): string {
    const attemptId = this.createId();
    const startedAt = this.now().toISOString();
    const attemptNumber = job.attemptCount + 1;
    this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE publish_jobs
        SET attempt_count = ?, updated_at = ?
        WHERE id = ? AND state = 'PREPARING' AND lease_owner = ?
      `).run(attemptNumber, startedAt, job.id, this.workerId);
      if (updated.changes !== 1) throw new Error(`Lost scheduler lease for job: ${job.id}`);
      this.database.prepare(`
        INSERT INTO publish_attempts (
          id, job_id, attempt_number, request_hash, state, receipt_json,
          started_at, finished_at, receipt_id, error_code, error_message
        ) VALUES (?, ?, ?, ?, 'PREPARING', NULL, ?, NULL, NULL, NULL, NULL)
      `).run(attemptId, job.id, attemptNumber, job.idempotencyKey, startedAt);
    }).immediate();
    return attemptId;
  }

  private markSubmissionStarted(
    job: JobContext,
    attemptId: string,
    envelope: AttemptEnvelope,
  ): void {
    const timestamp = this.now().toISOString();
    const leaseUntil = new Date(this.now().getTime() + this.leaseDurationMs).toISOString();
    const result = this.database.prepare(`
      UPDATE publish_jobs
      SET state = 'SUBMITTED', status_message = 'Submission started', last_error = NULL,
          updated_at = ?, lease_until = ?
      WHERE id = ? AND state = 'PREPARING' AND lease_owner = ?
    `).run(timestamp, leaseUntil, job.id, this.workerId);
    if (result.changes !== 1) throw new Error(`Lost scheduler lease for job: ${job.id}`);
    this.updateAttempt(attemptId, JobState.SUBMITTED, envelope);
  }

  private persistReceipt(
    job: JobContext,
    attemptId: string,
    prepared: PreparedPublication,
    receipt: SubmissionReceipt,
  ): void {
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE publish_jobs
        SET remote_publication_id = ?, remote_id = ?, updated_at = ?
        WHERE id = ? AND state = 'SUBMITTED' AND lease_owner = ?
      `).run(receipt.remoteId, receipt.remoteId, timestamp, job.id, this.workerId);
      if (updated.changes !== 1) throw new Error(`Lost scheduler lease for job: ${job.id}`);
      this.updateAttempt(attemptId, JobState.SUBMITTED, { prepared, receipt });
    })();
  }

  private finishClaimedJob(
    job: JobContext,
    attemptId: string,
    state: JobStateValue,
    message: string,
    envelope: AttemptEnvelope,
    errorCode: string | null = null,
  ): void {
    const timestamp = this.now().toISOString();
    const updated = this.database.prepare(`
      UPDATE publish_jobs
      SET state = ?, status_message = ?, last_error = ?, updated_at = ?,
          lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND lease_owner = ?
    `).run(state, message, errorCode ? message : null, timestamp, job.id, this.workerId);
    if (updated.changes !== 1) throw new Error(`Lost scheduler lease for job: ${job.id}`);
    this.updateAttempt(
      attemptId,
      state,
      envelope,
      errorCode,
      errorCode ? message : null,
      isFinishedState(state),
    );
  }

  private applyRemoteStatus(
    jobId: string,
    attemptId: string,
    status: RemotePublicationStatus,
    envelope: AttemptEnvelope,
    claimed: boolean,
  ): void {
    if (claimed) {
      const timestamp = this.now().toISOString();
      const keepLease = status.state === JobState.PROCESSING;
      const leaseUntil = keepLease
        ? new Date(this.now().getTime() + this.leaseDurationMs).toISOString()
        : null;
      const updated = this.database.prepare(`
        UPDATE publish_jobs
        SET state = ?, remote_publication_id = COALESCE(?, remote_publication_id),
            remote_id = COALESCE(?, remote_id), status_message = ?, last_error = NULL,
            updated_at = ?, lease_owner = ?, lease_until = ?
        WHERE id = ? AND lease_owner = ?
      `).run(
        status.state,
        status.remoteId,
        status.remoteId,
        status.message,
        timestamp,
        keepLease ? this.workerId : null,
        leaseUntil,
        jobId,
        this.workerId,
      );
      if (updated.changes !== 1) throw new Error(`Lost scheduler lease for job: ${jobId}`);
    } else {
      this.updateUnclaimedJob(jobId, status.state, status.message, status.remoteId);
    }
    this.updateAttempt(
      attemptId,
      status.state,
      envelope,
      null,
      null,
      isFinishedState(status.state),
    );
  }

  private updateUnclaimedJob(
    jobId: string,
    state: JobStateValue,
    message: string | null,
    remoteId: string | null,
  ): void {
    const timestamp = this.now().toISOString();
    const keepLease = state === JobState.PROCESSING;
    const leaseUntil = keepLease
      ? new Date(this.now().getTime() + this.leaseDurationMs).toISOString()
      : null;
    this.database.prepare(`
      UPDATE publish_jobs
      SET state = ?, remote_publication_id = COALESCE(?, remote_publication_id),
          remote_id = COALESCE(?, remote_id), status_message = ?,
          last_error = CASE WHEN ? = 'UNKNOWN' THEN ? ELSE NULL END,
          updated_at = ?, lease_owner = ?, lease_until = ?
      WHERE id = ?
    `).run(
      state,
      remoteId,
      remoteId,
      message,
      state,
      message,
      timestamp,
      keepLease ? this.workerId : null,
      leaseUntil,
      jobId,
    );
  }

  private updateAttempt(
    attemptId: string,
    state: JobStateValue,
    envelope: AttemptEnvelope,
    errorCode: string | null = null,
    error: string | null = null,
    finished = false,
  ): void {
    const timestamp = this.now().toISOString();
    const receiptId = envelope.receipt?.id ?? null;
    this.database.prepare(`
      UPDATE publish_attempts
      SET state = ?, receipt_json = ?, receipt_id = ?, error_code = ?, error_message = ?,
          finished_at = ?
      WHERE id = ?
    `).run(
      state,
      JSON.stringify(envelope),
      receiptId,
      errorCode,
      error,
      finished ? timestamp : null,
      attemptId,
    );
  }

  private latestAttempt(jobId: string): AttemptRow | undefined {
    return this.database.prepare(`
      SELECT id, receipt_json
      FROM publish_attempts
      WHERE job_id = ?
      ORDER BY attempt_number DESC
      LIMIT 1
    `).get(jobId) as AttemptRow | undefined;
  }

  private decodeAttemptEnvelope(value: string | null): AttemptEnvelope {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as AttemptEnvelope)
        : {};
    } catch {
      return {};
    }
  }
}
