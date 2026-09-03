import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEMP_PREFIX = 'belvoir-vercel-deploy-';
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function parseArguments(argv) {
  const options = { prod: false };
  for (const argument of argv) {
    if (argument === '--prod') options.prod = true;
    else if (argument.startsWith('--repo=')) options.repo = argument.slice('--repo='.length);
    else if (argument.startsWith('--sha=')) options.sha = argument.slice('--sha='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.repo) throw new Error('--repo=/absolute/repository/path is required');
  if (!options.sha || !FULL_COMMIT_SHA.test(options.sha)) {
    throw new Error('--sha must be a full commit SHA, not a branch or symbolic ref');
  }
  return options;
}

function runProcess(command, args, { cwd, inherit = false, lifecycle } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    if (lifecycle) lifecycle.child = child;
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.once('error', (error) => {
      if (lifecycle?.child === child) lifecycle.child = null;
      rejectPromise(error);
    });
    child.once('close', (status, signal) => {
      if (lifecycle?.child === child) lifecycle.child = null;
      if (status === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exit ${status}`);
      rejectPromise(new Error(`${command} ${args.join(' ')} failed: ${detail}`));
    });
  });
}

function runGit(repository, args, lifecycle) {
  return runProcess('git', ['-C', repository, ...args], { lifecycle });
}

function assertOwnedTemporaryRoot(temporaryRoot) {
  const expectedParent = resolve(tmpdir());
  const candidate = resolve(temporaryRoot);
  if (dirname(candidate) !== expectedParent || !basename(candidate).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to clean unowned temporary path: ${candidate}`);
  }
}

function unsafeCommittedPath(file) {
  const segments = file.split('/');
  if (segments.includes('node_modules')) return 'node_modules';
  if (segments.some((segment) => segment === '.env' || segment.startsWith('.env.'))) return '.env';
  if (file === '.vercel' || file.startsWith('.vercel/')) return '.vercel';
  return null;
}

async function listDeploymentFiles(root, directory = root) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const file = relative(root, absolute).split(sep).join('/');
    if (file === '.git') continue;
    if (entry.isDirectory()) files.push(...await listDeploymentFiles(root, absolute));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(file);
    else throw new Error(`Refusing deployment with unsupported filesystem entry: ${file}`);
  }
  return files.sort();
}

function compareFileSets(actual, expected) {
  if (actual.length === expected.length && actual.every((file, index) => file === expected[index])) return;
  const expectedFiles = new Set(expected);
  const actualFiles = new Set(actual);
  const unexpected = actual.filter((file) => !expectedFiles.has(file));
  const missing = expected.filter((file) => !actualFiles.has(file));
  throw new Error(
    `Deployment checkout differs from reviewed commit; unexpected=${JSON.stringify(unexpected)}, ` +
    `missing=${JSON.stringify(missing)}`,
  );
}

async function readProjectMetadata(repository) {
  const projectPath = join(repository, '.vercel', 'project.json');
  let metadataStat;
  try {
    metadataStat = await lstat(projectPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${projectPath} is required to link the reviewed deployment`);
    }
    throw error;
  }
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new Error(`${projectPath} must be a regular file, not a link`);
  }
  const bytes = await readFile(projectPath);
  let metadata;
  try {
    metadata = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${projectPath} must contain valid JSON`);
  }
  if (!metadata || typeof metadata.orgId !== 'string' || !metadata.orgId ||
      typeof metadata.projectId !== 'string' || !metadata.projectId) {
    throw new Error(`${projectPath} must contain non-empty orgId and projectId values`);
  }
  return {
    bytes,
    publicSummary: { orgId: metadata.orgId, projectId: metadata.projectId },
  };
}

async function cleanupTemporaryWorktree(repository, temporaryRoot, checkout, worktreeAdded) {
  if (!temporaryRoot) return;
  assertOwnedTemporaryRoot(temporaryRoot);
  let worktreeError = null;
  if (worktreeAdded) {
    try {
      await runGit(repository, ['worktree', 'remove', '--force', checkout]);
    } catch (error) {
      worktreeError = error;
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  if (worktreeError) throw worktreeError;
}

export async function deployReviewedVercel({ repository, reviewedSha, prod = false }) {
  const repositoryPath = await realpath(resolve(repository));
  const normalizedSha = reviewedSha.toLowerCase();
  const lifecycle = { child: null, signal: null };
  const recordSignal = (signal) => {
    lifecycle.signal ||= signal;
    if (lifecycle.child && !lifecycle.child.killed) lifecycle.child.kill(signal);
  };
  const onSigint = () => recordSignal('SIGINT');
  const onSigterm = () => recordSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  let temporaryRoot = null;
  let checkout = null;
  let worktreeAdded = false;
  let summary;
  let operationError = null;
  try {
    const resolvedCommit = (await runGit(
      repositoryPath,
      ['rev-parse', '--verify', `${normalizedSha}^{commit}`],
      lifecycle,
    )).toLowerCase();
    if (resolvedCommit !== normalizedSha) throw new Error('The requested SHA did not resolve exactly');

    const repositoryHead = await runGit(repositoryPath, ['rev-parse', 'HEAD'], lifecycle);
    const localMain = await runGit(repositoryPath, ['rev-parse', 'refs/heads/main'], lifecycle);
    const trackedStatus = await runGit(
      repositoryPath,
      ['status', '--porcelain', '--untracked-files=no'],
      lifecycle,
    );
    const projectMetadata = await readProjectMetadata(repositoryPath);
    if (repositoryHead.toLowerCase() !== normalizedSha) {
      throw new Error(`Repository HEAD ${repositoryHead} does not equal reviewed SHA ${normalizedSha}`);
    }
    if (localMain.toLowerCase() !== normalizedSha) {
      throw new Error(`Local main ${localMain} does not equal reviewed SHA ${normalizedSha}`);
    }
    if (trackedStatus) throw new Error('Repository has uncommitted tracked changes');

    temporaryRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    assertOwnedTemporaryRoot(temporaryRoot);
    checkout = join(temporaryRoot, 'checkout');
    await runGit(repositoryPath, ['worktree', 'add', '--detach', checkout, normalizedSha], lifecycle);
    worktreeAdded = true;

    const checkoutSha = (await runGit(checkout, ['rev-parse', 'HEAD'], lifecycle)).toLowerCase();
    if (checkoutSha !== normalizedSha) {
      throw new Error(`Detached checkout ${checkoutSha} does not equal reviewed SHA ${normalizedSha}`);
    }
    const trackedOutput = await runGit(checkout, ['ls-files', '-z'], lifecycle);
    const trackedFiles = trackedOutput ? trackedOutput.split('\0').filter(Boolean).sort() : [];
    const unsafe = trackedFiles
      .map((file) => ({ file, reason: unsafeCommittedPath(file) }))
      .find((entry) => entry.reason);
    if (unsafe) {
      throw new Error(`Refusing deployment: reviewed commit contains ${unsafe.reason} path ${unsafe.file}`);
    }

    const projectDirectory = join(checkout, '.vercel');
    await mkdir(projectDirectory, { recursive: false, mode: 0o700 });
    await writeFile(join(projectDirectory, 'project.json'), projectMetadata.bytes, {
      flag: 'wx',
      mode: 0o600,
    });

    const expectedFiles = [...trackedFiles, '.vercel/project.json'].sort();
    const deploymentFiles = await listDeploymentFiles(checkout);
    compareFileSets(deploymentFiles, expectedFiles);

    if (prod) {
      const finalCheckoutSha = (await runGit(checkout, ['rev-parse', 'HEAD'], lifecycle)).toLowerCase();
      if (finalCheckoutSha !== normalizedSha) {
        throw new Error(`Deployment checkout moved from reviewed SHA ${normalizedSha}`);
      }
      const vercelBinary = join(repositoryPath, 'node_modules', '.bin', 'vercel');
      await access(vercelBinary, constants.X_OK);
      await runProcess(
        vercelBinary,
        ['--cwd', checkout, '--prod', '--yes'],
        { cwd: repositoryPath, inherit: true, lifecycle },
      );
    }

    summary = {
      mode: prod ? 'production' : 'dry-run',
      deployed: prod,
      reviewedSha: normalizedSha,
      checkoutSha,
      files: deploymentFiles,
      project: projectMetadata.publicSummary,
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await cleanupTemporaryWorktree(repositoryPath, temporaryRoot, checkout, worktreeAdded);
    } catch (cleanupError) {
      operationError = operationError
        ? new AggregateError([operationError, cleanupError], `${operationError.message}; cleanup also failed`)
        : cleanupError;
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  if (lifecycle.signal) {
    const error = new Error(`Interrupted by ${lifecycle.signal} after cleaning the deployment checkout`);
    error.exitCode = lifecycle.signal === 'SIGINT' ? 130 : 143;
    throw error;
  }
  if (operationError) throw operationError;
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const summary = await deployReviewedVercel({
      repository: options.repo,
      reviewedSha: options.sha,
      prod: options.prod,
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
