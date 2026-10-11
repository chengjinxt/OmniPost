import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from './database.js';
import { PersistentJobQueue } from './job-queue.js';

const now = new Date('2026-10-12T08:00:00.000Z');

describe('PersistentJobQueue', () => {
  let database: BetterSqlite3.Database;
  let queue: PersistentJobQueue;

  beforeEach(() => {
    database = openDatabase(':memory:');
    queue = new PersistentJobQueue(database);
    insertAccount(database, 'account-a');
    insertAccount(database, 'account-b');
  });

  afterEach(() => {
    database.close();
  });

  it('claims at most one active job per account', () => {
    insertJob(database, 'job-a1', 'account-a', 'APPROVED');
    insertJob(database, 'job-a2', 'account-a', 'APPROVED');
    insertJob(database, 'job-b1', 'account-b', 'APPROVED');

    const first = queue.claimNextDue('worker-1', now, 60_000);
    const second = queue.claimNextDue('worker-2', now, 60_000);
    const third = queue.claimNextDue('worker-3', now, 60_000);

    expect(first?.id).toBe('job-a1');
    expect(second?.id).toBe('job-b1');
    expect(third).toBeUndefined();
    expect(first).toMatchObject({ state: 'PREPARING', leaseOwner: 'worker-1' });
  });

  it('does not claim jobs scheduled in the future', () => {
    insertJob(database, 'future', 'account-a', 'SCHEDULED', '2026-10-12T09:00:00.000Z');

    expect(queue.claimNextDue('worker-1', now, 60_000)).toBeUndefined();
  });

  it('moves startup-missed schedules to NEEDS_ACTION instead of backfilling', () => {
    insertJob(database, 'missed', 'account-a', 'SCHEDULED', '2026-10-12T07:59:59.000Z');
    insertJob(database, 'upcoming', 'account-b', 'SCHEDULED', '2026-10-12T08:00:01.000Z');

    const recovery = queue.recoverAfterRestart(now);

    expect(recovery).toEqual({ interrupted: 0, missed: 1 });
    expect(readState(database, 'missed')).toBe('NEEDS_ACTION');
    expect(readState(database, 'upcoming')).toBe('SCHEDULED');
  });

  it('marks interrupted submissions UNKNOWN so they cannot be submitted twice', () => {
    insertJob(database, 'preparing', 'account-a', 'PREPARING');
    insertJob(database, 'submitted', 'account-b', 'SUBMITTED');

    const recovery = queue.recoverAfterRestart(now);

    expect(recovery).toEqual({ interrupted: 2, missed: 0 });
    expect(readState(database, 'preparing')).toBe('UNKNOWN');
    expect(readState(database, 'submitted')).toBe('UNKNOWN');
    expect(queue.claimNextDue('worker', now, 60_000)).toBeUndefined();
  });
});

function insertAccount(database: BetterSqlite3.Database, id: string): void {
  const timestamp = '2026-10-12T00:00:00.000Z';
  database.prepare(`
    INSERT INTO account_connections (
      id, platform, display_name, credential_ref, capabilities_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'YOUTUBE', id, null, '{}', 'CONNECTED', timestamp, timestamp);
}

function insertJob(
  database: BetterSqlite3.Database,
  id: string,
  accountId: string,
  state: string,
  scheduledAt: string | null = null,
): void {
  const timestamp = '2026-10-12T00:00:00.000Z';
  database.prepare(`
    INSERT INTO publish_jobs (
      id, plan_id, account_id, platform, variant_id, state, idempotency_key,
      scheduled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, null, accountId, 'YOUTUBE', null, state, `key-${id}`, scheduledAt, timestamp, timestamp);
}

function readState(database: BetterSqlite3.Database, id: string): string {
  return database.prepare('SELECT state FROM publish_jobs WHERE id = ?').pluck().get(id) as string;
}
