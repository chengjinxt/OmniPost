import { describe, expect, it } from 'vitest';

import { openDatabase } from '../infrastructure/database.js';
import type { SchedulerRunResult } from '../scheduler/persistent-scheduler.js';
import {
  DesktopSchedulerNotificationPort,
  NonOverlappingSchedulerLoop,
  PublishingRuntime,
  createPublishingRuntime,
  type IntervalPort,
} from './scheduler-runtime.js';

class ManualIntervals implements IntervalPort {
  callback: (() => void) | undefined;
  cleared = false;

  set(callback: () => void, _intervalMs: number): object {
    this.callback = callback;
    return this;
  }

  clear(handle: object): void {
    if (handle === this) this.cleared = true;
  }
}

describe('DesktopSchedulerNotificationPort', () => {
  it('shows a desktop notification and reveals the main window for assisted work', async () => {
    const events: string[] = [];
    const port = new DesktopSchedulerNotificationPort({
      async showNotification(input) {
        events.push(`notification:${input.title}:${input.body}`);
      },
      async revealMainWindow() {
        events.push('reveal');
      },
    });

    await port.notify({
      kind: 'ASSISTED_BROWSER_READY',
      jobId: 'job-1',
      platform: 'CSDN',
      message: '等待最终确认',
    });

    expect(events).toEqual([
      'notification:OmniPost · CSDN:等待最终确认',
      'reveal',
    ]);
  });

  it('does not reveal the main window for an uncertain background submission', async () => {
    const events: string[] = [];
    const port = new DesktopSchedulerNotificationPort({
      async showNotification() { events.push('notification'); },
      async revealMainWindow() { events.push('reveal'); },
    });

    await port.notify({
      kind: 'SUBMISSION_UNKNOWN',
      jobId: 'job-1',
      platform: 'YOUTUBE',
      message: '远端状态未知',
    });

    expect(events).toEqual(['notification']);
  });
});

describe('NonOverlappingSchedulerLoop', () => {
  it('skips overlapping ticks and invokes the scheduler only once', async () => {
    let release!: (value: SchedulerRunResult | null) => void;
    let calls = 0;
    const pending = new Promise<SchedulerRunResult | null>((resolve) => { release = resolve; });
    const loop = new NonOverlappingSchedulerLoop({
      runner: { async runNext() { calls += 1; return pending; } },
      intervalMs: 30_000,
      intervals: new ManualIntervals(),
    });

    const first = loop.tick();
    const overlapping = await loop.tick();
    release({ action: 'EXECUTED', jobId: 'job-1', state: 'UNKNOWN' });

    expect(overlapping).toEqual({ status: 'BUSY' });
    await expect(first).resolves.toEqual({
      status: 'RAN',
      result: { action: 'EXECUTED', jobId: 'job-1', state: 'UNKNOWN' },
    });
    expect(calls).toBe(1);
  });

  it('reports a directly started tick as active until it settles', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const loop = new NonOverlappingSchedulerLoop({
      runner: { async runNext() { await pending; return null; } },
      intervalMs: 30_000,
      intervals: new ManualIntervals(),
    });

    const tick = loop.tick();
    let idle = false;
    const waiting = loop.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await tick;
    await waiting;
    expect(idle).toBe(true);
  });

  it('runs at most one scheduler step per interval and can be stopped', async () => {
    const intervals = new ManualIntervals();
    let calls = 0;
    const loop = new NonOverlappingSchedulerLoop({
      runner: { async runNext() { calls += 1; return null; } },
      intervalMs: 30_000,
      intervals,
    });

    loop.start();
    intervals.callback?.();
    await loop.whenIdle();
    loop.stop();

    expect(calls).toBe(1);
    expect(intervals.cleared).toBe(true);
  });

  it('reports interval failures without creating an unhandled rejection', async () => {
    const intervals = new ManualIntervals();
    const errors: unknown[] = [];
    const loop = new NonOverlappingSchedulerLoop({
      runner: { async runNext() { throw new Error('database unavailable'); } },
      intervalMs: 30_000,
      intervals,
      onError(error) { errors.push(error); },
    });

    loop.start();
    intervals.callback?.();
    await loop.whenIdle();

    expect(errors).toEqual([expect.objectContaining({ message: 'database unavailable' })]);
  });
});

describe('PublishingRuntime', () => {
  it('can stop safely during the first tick without starting the interval afterward', async () => {
    let release!: () => void;
    const firstTick = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const runtime = new PublishingRuntime({
      recovery: {
        recoverAfterRestart() { return { interrupted: 0, missed: 0 }; },
      },
      loop: {
        async tick() {
          events.push('tick');
          await firstTick;
          return { status: 'RAN', result: null };
        },
        start() { events.push('interval:start'); },
        stop() { events.push('interval:stop'); },
        whenIdle() { return firstTick; },
      },
    });

    const starting = runtime.start();
    await Promise.resolve();
    const stopping = runtime.stop();
    release();
    await Promise.all([starting, stopping]);

    expect(events).toEqual(['tick', 'interval:stop']);
  });

  it('recovers missed jobs before the first scheduler tick and does not auto-send them', async () => {
    const events: string[] = [];
    const runtime = new PublishingRuntime({
      recovery: {
        recoverAfterRestart(startedAt) {
          events.push(`recover:${startedAt.toISOString()}`);
          return { interrupted: 1, missed: 2 };
        },
      },
      loop: {
        async tick() {
          events.push('tick');
          return { status: 'RAN', result: null };
        },
        start() { events.push('start'); },
        stop() { events.push('stop'); },
        whenIdle() { return Promise.resolve(); },
      },
      now: () => new Date('2026-10-12T08:00:00.000Z'),
    });

    const recovery = await runtime.start();
    runtime.stop();

    expect(recovery).toEqual({ interrupted: 1, missed: 2 });
    expect(events).toEqual([
      'recover:2026-10-12T08:00:00.000Z',
      'tick',
      'start',
      'stop',
    ]);
  });

  it('returns one repeat-safe stop promise that waits for the scheduler loop to become idle', async () => {
    let releaseIdle!: () => void;
    let stopCalls = 0;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const runtime = new PublishingRuntime({
      recovery: {
        recoverAfterRestart() {
          return { interrupted: 0, missed: 0 };
        },
      },
      loop: {
        async tick() {
          return { status: 'RAN', result: null };
        },
        start() {},
        stop() {
          stopCalls += 1;
        },
        whenIdle() {
          return idle;
        },
      },
    });
    await runtime.start();

    const firstStop = runtime.stop();
    const repeatedStop = runtime.stop();
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(repeatedStop).toBe(firstStop);
    expect(stopCalls).toBe(1);
    expect(stopped).toBe(false);

    releaseIdle();
    await firstStop;
    expect(stopped).toBe(true);
  });

  it('wires the persistent scheduler and marks an overdue schedule NEEDS_ACTION before fetching', async () => {
    const database = openDatabase(':memory:');
    const intervals = new ManualIntervals();
    let fetchCalls = 0;
    seedOverdueJob(database);
    const runtime = createPublishingRuntime({
      database,
      revisions: { getRevision() { return null; } },
      accounts: { getAccount() { return null; } },
      desktop: { showNotification() {} },
      async fetchImplementation() {
        fetchCalls += 1;
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      intervals,
      now: () => new Date('2026-10-12T08:00:00.000Z'),
    });

    try {
      const recovery = await runtime.start();
      const state = database.prepare(
        'SELECT state FROM publish_jobs WHERE id = ?',
      ).pluck().get('job-overdue');

      expect(recovery).toEqual({ interrupted: 0, missed: 1 });
      expect(state).toBe('NEEDS_ACTION');
      expect(fetchCalls).toBe(0);
    } finally {
      runtime.stop();
      database.close();
    }
  });
});

function seedOverdueJob(database: ReturnType<typeof openDatabase>): void {
  const createdAt = '2026-10-12T06:00:00.000Z';
  const scheduledAt = '2026-10-12T07:00:00.000Z';
  const hash = 'c'.repeat(64);
  const target = {
    accountId: 'account-overdue',
    platform: 'YOUTUBE',
    deliveryMode: 'DIRECT_API',
    scheduledAt,
    platformFields: {},
  };
  database.prepare(`
    INSERT INTO account_connections (
      id, platform, display_name, credential_ref, capabilities_json, status,
      created_at, updated_at, delivery_mode
    ) VALUES ('account-overdue', 'YOUTUBE', 'channel', NULL, '{}', 'CONNECTED', ?, ?, 'DIRECT_API')
  `).run(createdAt, createdAt);
  database.prepare(`
    INSERT INTO content_items (
      id, title, kind, source_type, created_at, updated_at, current_revision_id, source_json
    ) VALUES ('item-overdue', 'video', 'VIDEO', 'TEST', ?, ?, NULL, NULL)
  `).run(createdAt, createdAt);
  database.prepare(`
    INSERT INTO content_revisions (
      id, item_id, revision_number, title, body_markdown, body_html,
      media_manifest_json, source_metadata_json, content_hash, created_at, kind, source_hash
    ) VALUES ('revision-overdue', 'item-overdue', 1, 'video', '', '', '[]', '{}', ?, ?, 'VIDEO', NULL)
  `).run(hash, createdAt);
  database.prepare(
    "UPDATE content_items SET current_revision_id = 'revision-overdue' WHERE id = 'item-overdue'",
  ).run();
  database.prepare(`
    INSERT INTO publish_plans (
      id, revision_id, scheduled_at, timezone, approval_hash, approved_at,
      created_at, updated_at, variant_ids_json, targets_json, content_hash, approved_by
    ) VALUES ('plan-overdue', 'revision-overdue', ?, 'Asia/Shanghai', ?, ?, ?, ?, '[]', ?, ?, 'local-user')
  `).run(scheduledAt, hash, createdAt, createdAt, createdAt, JSON.stringify([target]), hash);
  database.prepare(`
    INSERT INTO publish_jobs (
      id, plan_id, account_id, platform, variant_id, state, idempotency_key,
      scheduled_at, created_at, updated_at, revision_id, delivery_mode,
      attempt_count, remote_publication_id, status_message
    ) VALUES (
      'job-overdue', 'plan-overdue', 'account-overdue', 'YOUTUBE', NULL,
      'SCHEDULED', ?, ?, ?, ?, 'revision-overdue', 'DIRECT_API', 0, NULL, NULL
    )
  `).run(`publish_${'d'.repeat(64)}`, scheduledAt, createdAt, createdAt);
}
