import { randomUUID } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import type { RecoveryResult } from '../infrastructure/job-queue.js';
import { PersistentJobQueue } from '../infrastructure/job-queue.js';
import {
  PersistentSchedulerService,
  type NotificationPort,
  type SchedulerNotification,
  type SchedulerRunResult,
} from '../scheduler/persistent-scheduler.js';
import {
  FetchHttpTransport,
  createLaunchAdapterRegistry,
  type AccountLookup,
  type AssistedFlowPort,
  type RevisionLookup,
} from './adapter-registry.js';

export interface DesktopNotificationSink {
  showNotification(input: { title: string; body: string }): void | Promise<void>;
  revealMainWindow?(): void | Promise<void>;
}

export class DesktopSchedulerNotificationPort implements NotificationPort {
  public constructor(private readonly desktop: DesktopNotificationSink) {}

  public async notify(notification: SchedulerNotification): Promise<void> {
    await this.desktop.showNotification({
      title: `OmniPost · ${notification.platform}`,
      body: notification.message,
    });
    if (
      notification.kind === 'ASSISTED_BROWSER_READY' &&
      this.desktop.revealMainWindow
    ) {
      await this.desktop.revealMainWindow();
    }
  }
}

export interface SchedulerRunner {
  runNext(): Promise<SchedulerRunResult | null>;
}

export interface IntervalPort {
  set(callback: () => void, intervalMs: number): object;
  clear(handle: object): void;
}

const systemIntervals: IntervalPort = {
  set(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export type SchedulerTickResult =
  | { status: 'BUSY' }
  | { status: 'RAN'; result: SchedulerRunResult | null };

export interface NonOverlappingSchedulerLoopOptions {
  runner: SchedulerRunner;
  intervalMs: number;
  intervals?: IntervalPort;
  onError?: (error: unknown) => void;
}

export class NonOverlappingSchedulerLoop {
  private readonly intervals: IntervalPort;
  private readonly onError: (error: unknown) => void;
  private intervalHandle: object | undefined;
  private activeTask: Promise<SchedulerTickResult> | undefined;

  public constructor(private readonly options: NonOverlappingSchedulerLoopOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error('Scheduler interval must be a positive number');
    }
    this.intervals = options.intervals ?? systemIntervals;
    this.onError = options.onError ?? (() => undefined);
  }

  public start(): void {
    if (this.intervalHandle !== undefined) return;
    this.intervalHandle = this.intervals.set(() => {
      void this.tick().catch((error: unknown) => this.onError(error));
    }, this.options.intervalMs);
  }

  public stop(): void {
    if (this.intervalHandle === undefined) return;
    this.intervals.clear(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  public tick(): Promise<SchedulerTickResult> {
    if (this.activeTask !== undefined) {
      return Promise.resolve({ status: 'BUSY' });
    }
    const task = this.runTick();
    this.activeTask = task;
    void task.then(
      () => {
        if (this.activeTask === task) this.activeTask = undefined;
      },
      () => {
        if (this.activeTask === task) this.activeTask = undefined;
      },
    );
    return task;
  }

  public whenIdle(): Promise<void> {
    return this.activeTask?.then(
      () => undefined,
      () => undefined,
    ) ?? Promise.resolve();
  }

  private async runTick(): Promise<SchedulerTickResult> {
    return { status: 'RAN', result: await this.options.runner.runNext() };
  }
}

export interface RestartRecovery {
  recoverAfterRestart(startedAt: Date): RecoveryResult;
}

export interface RuntimeLoop {
  tick(): Promise<SchedulerTickResult>;
  start(): void;
  stop(): void;
  whenIdle(): Promise<void>;
}

export interface PublishingRuntimeOptions {
  recovery: RestartRecovery;
  loop: RuntimeLoop;
  now?: () => Date;
}

export class PublishingRuntime {
  private readonly now: () => Date;
  private started = false;
  private stopTask: Promise<void> | undefined;

  public constructor(private readonly options: PublishingRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async start(): Promise<RecoveryResult> {
    if (this.stopTask) await this.stopTask;
    if (this.started) {
      throw new Error('Publishing runtime has already been started');
    }
    this.started = true;
    const recovery = this.options.recovery.recoverAfterRestart(this.now());
    await this.options.loop.tick();
    if (this.started) this.options.loop.start();
    return recovery;
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.options.loop.stop();
    this.started = false;
    const task = this.options.loop.whenIdle();
    this.stopTask = task;
    void task.then(
      () => {
        if (this.stopTask === task) this.stopTask = undefined;
      },
      () => {
        if (this.stopTask === task) this.stopTask = undefined;
      },
    );
    return task;
  }
}

export interface CreatePublishingRuntimeOptions {
  database: BetterSqlite3.Database;
  revisions: RevisionLookup;
  accounts: AccountLookup;
  desktop: DesktopNotificationSink;
  assistedFlows?: AssistedFlowPort;
  fetchImplementation?: typeof globalThis.fetch;
  queue?: PersistentJobQueue;
  workerId?: string;
  intervalMs?: number;
  leaseDurationMs?: number;
  submitTimeoutMs?: number;
  now?: () => Date;
  intervals?: IntervalPort;
  onError?: (error: unknown) => void;
}

export function createPublishingRuntime(
  options: CreatePublishingRuntimeOptions,
): PublishingRuntime {
  const now = options.now ?? (() => new Date());
  const queue = options.queue ?? new PersistentJobQueue(options.database);
  const transport = new FetchHttpTransport(
    options.fetchImplementation ?? globalThis.fetch,
  );
  const adapters = createLaunchAdapterRegistry({
    transport,
    revisions: options.revisions,
    accounts: options.accounts,
    ...(options.assistedFlows ? { assistedFlows: options.assistedFlows } : {}),
    now: () => now().toISOString(),
  });
  const notifications = new DesktopSchedulerNotificationPort(options.desktop);
  const scheduler = new PersistentSchedulerService({
    database: options.database,
    queue,
    adapters,
    notifications,
    workerId: options.workerId ?? `desktop-${randomUUID()}`,
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    submitTimeoutMs: options.submitTimeoutMs ?? 60_000,
    now,
  });
  const loop = new NonOverlappingSchedulerLoop({
    runner: scheduler,
    intervalMs: options.intervalMs ?? 15_000,
    ...(options.intervals ? { intervals: options.intervals } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return new PublishingRuntime({ recovery: queue, loop, now });
}
