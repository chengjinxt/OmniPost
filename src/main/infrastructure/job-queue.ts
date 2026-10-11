import type BetterSqlite3 from 'better-sqlite3';

export interface ClaimedJob {
  id: string;
  accountId: string;
  platform: string;
  state: 'PREPARING';
  idempotencyKey: string;
  scheduledAt: string | null;
  leaseOwner: string;
  leaseUntil: string;
}

export interface RecoveryResult {
  interrupted: number;
  missed: number;
}

interface JobRow {
  id: string;
  account_id: string;
  platform: string;
  state: 'PREPARING';
  idempotency_key: string;
  scheduled_at: string | null;
  lease_owner: string;
  lease_until: string;
}

export class PersistentJobQueue {
  public constructor(private readonly database: BetterSqlite3.Database) {}

  claimNextDue(workerId: string, now: Date, leaseDurationMs: number): ClaimedJob | undefined {
    const timestamp = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();

    return this.database.transaction(() => {
      const candidate = this.database.prepare(`
        SELECT id
        FROM publish_jobs AS candidate
        WHERE (
          candidate.state = 'APPROVED'
          OR (candidate.state = 'SCHEDULED' AND candidate.scheduled_at <= ?)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM publish_jobs AS active
          WHERE active.account_id = candidate.account_id
            AND active.id != candidate.id
            AND active.state IN ('PREPARING', 'SUBMITTED', 'PROCESSING')
            AND active.lease_until > ?
        )
        ORDER BY COALESCE(candidate.scheduled_at, candidate.created_at), candidate.id
        LIMIT 1
      `).pluck().get(timestamp, timestamp) as string | undefined;

      if (candidate === undefined) {
        return undefined;
      }

      this.database.prepare(`
        UPDATE publish_jobs
        SET state = 'PREPARING', lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(workerId, leaseUntil, timestamp, candidate);

      const row = this.database.prepare(`
        SELECT id, account_id, platform, state, idempotency_key, scheduled_at, lease_owner, lease_until
        FROM publish_jobs
        WHERE id = ?
      `).get(candidate) as JobRow;

      return {
        id: row.id,
        accountId: row.account_id,
        platform: row.platform,
        state: row.state,
        idempotencyKey: row.idempotency_key,
        scheduledAt: row.scheduled_at,
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
      };
    }).immediate();
  }

  recoverAfterRestart(startedAt: Date): RecoveryResult {
    const timestamp = startedAt.toISOString();

    return this.database.transaction(() => {
      const interrupted = this.database.prepare(`
        UPDATE publish_jobs
        SET state = 'UNKNOWN', lease_owner = NULL, lease_until = NULL,
            last_error = 'Application restarted while delivery was active', updated_at = ?
        WHERE state IN ('PREPARING', 'SUBMITTED', 'PROCESSING')
      `).run(timestamp).changes;

      const missed = this.database.prepare(`
        UPDATE publish_jobs
        SET state = 'NEEDS_ACTION',
            last_error = 'Scheduled time passed while the application was not running', updated_at = ?
        WHERE state = 'SCHEDULED' AND scheduled_at < ?
      `).run(timestamp, timestamp).changes;

      return { interrupted, missed };
    }).immediate();
  }
}
