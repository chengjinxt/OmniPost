import { z } from 'zod';

import { PublishJobSchema, type PublishJob } from './entities.js';
import {
  IsoDateTimeSchema,
  JobState,
  deepFreeze,
  type JobState as JobStateValue,
} from './primitives.js';

const TRANSITIONS: Readonly<Record<JobStateValue, readonly JobStateValue[]>> = {
  [JobState.DRAFT]: [JobState.AWAITING_APPROVAL, JobState.CANCELLED],
  [JobState.AWAITING_APPROVAL]: [JobState.APPROVED, JobState.CANCELLED],
  [JobState.APPROVED]: [
    JobState.SCHEDULED,
    JobState.PREPARING,
    JobState.AWAITING_APPROVAL,
    JobState.CANCELLED,
  ],
  [JobState.SCHEDULED]: [
    JobState.PREPARING,
    JobState.NEEDS_ACTION,
    JobState.AWAITING_APPROVAL,
    JobState.CANCELLED,
  ],
  [JobState.PREPARING]: [
    JobState.SUBMITTED,
    JobState.NEEDS_ACTION,
    JobState.FAILED,
    JobState.CANCELLED,
  ],
  [JobState.SUBMITTED]: [
    JobState.PROCESSING,
    JobState.PUBLISHED,
    JobState.REJECTED,
    JobState.NEEDS_ACTION,
    JobState.FAILED,
    JobState.UNKNOWN,
  ],
  [JobState.PROCESSING]: [
    JobState.PUBLISHED,
    JobState.REJECTED,
    JobState.NEEDS_ACTION,
    JobState.FAILED,
    JobState.UNKNOWN,
  ],
  [JobState.PUBLISHED]: [],
  [JobState.REJECTED]: [],
  [JobState.NEEDS_ACTION]: [
    JobState.AWAITING_APPROVAL,
    JobState.APPROVED,
    JobState.PREPARING,
    JobState.CANCELLED,
  ],
  [JobState.FAILED]: [JobState.PREPARING],
  [JobState.UNKNOWN]: [
    JobState.PROCESSING,
    JobState.PUBLISHED,
    JobState.REJECTED,
    JobState.NEEDS_ACTION,
    JobState.FAILED,
  ],
  [JobState.CANCELLED]: [],
};

export const canTransitionJobState = (
  from: JobStateValue,
  to: JobStateValue,
): boolean => TRANSITIONS[from].includes(to);

const TransitionContextSchema = z
  .object({
    now: IsoDateTimeSchema,
    reason: z.string().trim().min(1).optional(),
    manualRetry: z.boolean().optional(),
  })
  .strict();

export type TransitionContext = z.input<typeof TransitionContextSchema>;

export const transitionPublishJob = (
  jobInput: PublishJob,
  nextState: JobStateValue,
  contextInput: TransitionContext,
): PublishJob => {
  const job = PublishJobSchema.parse(jobInput);
  const context = TransitionContextSchema.parse(contextInput);

  if (!canTransitionJobState(job.state, nextState)) {
    throw new Error(`Illegal PublishJob transition: ${job.state} -> ${nextState}`);
  }

  if (job.state === JobState.FAILED && nextState === JobState.PREPARING && !context.manualRetry) {
    throw new Error('FAILED jobs require an explicit manual retry');
  }

  if (job.state === JobState.SCHEDULED && nextState === JobState.NEEDS_ACTION) {
    if (job.scheduledAt === null || Date.parse(job.scheduledAt) > Date.parse(context.now)) {
      throw new Error('A scheduled job can enter NEEDS_ACTION only after its scheduled time');
    }
  }

  if (nextState === JobState.SCHEDULED && job.scheduledAt === null) {
    throw new Error('A scheduled job requires scheduledAt');
  }

  return deepFreeze(
    PublishJobSchema.parse({
      ...job,
      state: nextState,
      attemptCount:
        nextState === JobState.PREPARING ? job.attemptCount + 1 : job.attemptCount,
      statusMessage: context.reason ?? null,
      updatedAt: context.now,
    }),
  );
};
