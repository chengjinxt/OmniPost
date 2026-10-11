import { resolve } from 'node:path';
import { z } from 'zod';

const safeIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Expected a safe identifier without path separators.');

export interface RunArtifactContext {
  runId: string;
  platform: string;
  accountId: string;
  jobId: string;
}

function safeIdentifier(value: string): string {
  const result = safeIdentifierSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Expected a safe identifier: ${value || '<empty>'}`);
  }
  return result.data;
}

export function resolveBrowserProfilePath(
  applicationDataPath: string,
  platform: string,
  accountId: string,
): string {
  return resolve(
    applicationDataPath,
    'browser-profiles',
    safeIdentifier(platform).toLowerCase(),
    safeIdentifier(accountId),
  );
}

export function resolveRunArtifactPath(
  applicationDataPath: string,
  context: RunArtifactContext,
): string {
  return resolve(
    applicationDataPath,
    'run-artifacts',
    safeIdentifier(context.runId),
    safeIdentifier(context.platform).toLowerCase(),
    safeIdentifier(context.accountId),
    safeIdentifier(context.jobId),
  );
}
