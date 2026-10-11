import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_NODE_MINOR = '24.21';
const REQUIRED_PNPM_VERSION = '11.25.0';

export function parsePnpmVersion(userAgent: string | undefined): string | undefined {
  return userAgent?.match(/(?:^|\s)pnpm\/([^\s]+)/)?.[1];
}

export function checkToolchain(nodeVersion: string, pnpmVersion: string | undefined): string[] {
  const normalizedNodeVersion = nodeVersion.replace(/^v/, '');
  const problems: string[] = [];

  if (!normalizedNodeVersion.startsWith(`${REQUIRED_NODE_MINOR}.`)) {
    problems.push(`Node.js ${REQUIRED_NODE_MINOR}.x is required; received ${nodeVersion}.`);
  }

  if (pnpmVersion !== REQUIRED_PNPM_VERSION) {
    problems.push(`pnpm ${REQUIRED_PNPM_VERSION} is required; received ${pnpmVersion ?? 'unknown'}.`);
  }

  return problems;
}

const isEntryPoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const problems = checkToolchain(
    process.version,
    parsePnpmVersion(process.env.npm_config_user_agent),
  );

  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error('Run `nvm use 24.21.0` and use Corepack-managed pnpm before continuing.');
    process.exitCode = 1;
  }
}
