import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEMP_PREFIX = 'belvoir-vercel-deploy-';
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_METADATA_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const SAFE_READ_FLAGS = constants.O_RDONLY |
  (constants.O_NOFOLLOW || 0) |
  (constants.O_NONBLOCK || 0);

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

function interruptionError(lifecycle) {
  const error = new Error(`Interrupted by ${lifecycle.signal}; production deployment was not started`);
  error.exitCode = lifecycle.signal === 'SIGINT' ? 130 : 143;
  return error;
}

function throwIfAborted(lifecycle) {
  if (lifecycle.controller.signal.aborted) throw interruptionError(lifecycle);
}

async function checked(lifecycle, promise) {
  throwIfAborted(lifecycle);
  const result = await promise;
  throwIfAborted(lifecycle);
  return result;
}

async function checkedOpen(lifecycle, file, flags) {
  throwIfAborted(lifecycle);
  const handle = await open(file, flags);
  try {
    throwIfAborted(lifecycle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function childIsRunning(record) {
  return record?.child.exitCode === null && record.child.signalCode === null;
}

function clearChildShutdown(record) {
  if (!record?.shutdownTimer) return;
  clearTimeout(record.shutdownTimer);
  record.shutdownTimer = null;
}

function signalOwnedChild(record, signal) {
  if (!childIsRunning(record)) return false;
  if (record.processGroup) {
    try {
      process.kill(-record.child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        try {
          return record.child.kill(signal);
        } catch {
          return false;
        }
      }
    }
  }
  try {
    return record.child.kill(signal);
  } catch {
    return false;
  }
}

function armChildShutdown(lifecycle, record) {
  if (record.shutdownTimer || !childIsRunning(record)) return;
  record.shutdownTimer = setTimeout(() => {
    record.shutdownTimer = null;
    if (!lifecycle.cleaning && lifecycle.child === record && childIsRunning(record)) {
      signalOwnedChild(record, 'SIGKILL');
    }
  }, lifecycle.shutdownGraceMs);
}

function runProcess(command, args, {
  cwd,
  inherit = false,
  lifecycle,
  allowAborted = false,
  ownedProcessGroup = false,
} = {}) {
  if (lifecycle && !allowAborted) throwIfAborted(lifecycle);
  return new Promise((resolvePromise, rejectPromise) => {
    const processGroup = ownedProcessGroup && process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      detached: processGroup,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    const record = { child, processGroup, shutdownTimer: null };
    if (lifecycle) lifecycle.child = record;
    let stdout = '';
    let stderr = '';
    let settled = false;
    if (!inherit) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearChildShutdown(record);
      if (lifecycle?.child === record) lifecycle.child = null;
      rejectPromise(error);
    });
    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearChildShutdown(record);
      if (lifecycle?.child === record) lifecycle.child = null;
      if (status === 0) {
        resolvePromise(stdout);
        return;
      }
      const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exit ${status}`);
      rejectPromise(new Error(`${command} ${args.join(' ')} failed: ${detail}`));
    });
  });
}

async function runGit(repository, args, lifecycle, { raw = false, cleanup = false } = {}) {
  const output = await runProcess('git', ['-C', repository, ...args], {
    lifecycle,
    allowAborted: cleanup,
  });
  if (!cleanup) throwIfAborted(lifecycle);
  return raw ? output : output.trim();
}

function assertOwnedTemporaryPaths(temporaryRoot, checkout, expectedParent) {
  const ownedParent = resolve(expectedParent);
  const ownedRoot = resolve(temporaryRoot);
  const ownedCheckout = resolve(checkout);
  if (dirname(ownedRoot) !== ownedParent || !basename(ownedRoot).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to clean unowned temporary path: ${ownedRoot}`);
  }
  if (dirname(ownedCheckout) !== ownedRoot || basename(ownedCheckout) !== 'checkout') {
    throw new Error(`Refusing to clean checkout outside helper-owned temporary root: ${ownedCheckout}`);
  }
}

function safeCheckoutPath(checkout, file) {
  if (!file || file.includes('\0') || file.includes('\\') || isAbsolute(file)) {
    throw new Error(`Refusing deployment path outside reviewed checkout: ${JSON.stringify(file)}`);
  }
  const segments = file.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Refusing deployment path escape: ${JSON.stringify(file)}`);
  }
  const absolute = resolve(checkout, ...segments);
  const fromCheckout = relative(resolve(checkout), absolute);
  if (!fromCheckout || fromCheckout.startsWith(`..${sep}`) || isAbsolute(fromCheckout)) {
    throw new Error(`Refusing deployment path escape: ${JSON.stringify(file)}`);
  }
  return absolute;
}

function unsafeCommittedPath(file) {
  const segments = file.toLowerCase().split('/');
  const name = segments.at(-1);
  if (segments.includes('node_modules')) return 'node_modules';
  if (segments.includes('.vercel')) return '.vercel';
  if (segments.some((segment) => segment.startsWith('.env'))) return '.env*';
  if (segments.includes('.npmrc')) return '.npmrc';
  if (segments.some((segment) => segment.startsWith('.yarnrc'))) return '.yarnrc*';
  if (segments.includes('.netrc') || segments.includes('.dockercfg')) return name;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/.test(name)) return 'credential key';
  if (segments.some((segment) => /(?:credential|private[-_.]?key)/.test(segment))) {
    return 'credential/private-key';
  }
  if (/\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore)$/.test(name)) {
    return 'private-key/certificate';
  }
  return null;
}

async function readGitManifest(repository, reviewedSha, lifecycle) {
  const output = await runGit(
    repository,
    ['ls-tree', '-r', '-z', '-l', '--full-tree', reviewedSha],
    lifecycle,
    { raw: true },
  );
  const manifest = [];
  let totalBytes = 0;
  for (const record of output.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const header = separator >= 0 ? record.slice(0, separator) : '';
    const file = separator >= 0 ? record.slice(separator + 1) : '';
    const parsed = /^(\d{6}) ([^ ]+) ([0-9a-f]+) +([0-9]+|-)$/.exec(header);
    if (!parsed) throw new Error(`Unable to parse reviewed Git tree entry: ${JSON.stringify(record)}`);
    const [, mode, type, oid, sizeText] = parsed;
    safeCheckoutPath('/validation-root', file);
    if (mode === '120000') throw new Error(`Refusing deployment: tracked symbolic link ${file}`);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || sizeText === '-') {
      throw new Error(`Refusing deployment: unsupported Git type/mode ${type}/${mode} for ${file}`);
    }
    const unsafe = unsafeCommittedPath(file);
    if (unsafe) throw new Error(`Refusing deployment: sensitive ${unsafe} path ${file}`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Refusing deployment: invalid Git blob size for ${file}`);
    }
    if (size > MAX_FILE_BYTES) {
      throw new Error(`Refusing deployment: oversized file ${file} exceeds 8 MiB`);
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Refusing deployment: reviewed files exceed the 64 MiB total size limit');
    }
    manifest.push({ file, mode, oid: oid.toLowerCase(), size });
  }
  return manifest.sort((left, right) => left.file.localeCompare(right.file));
}

async function listDeploymentFiles(root, lifecycle, directory = root) {
  const files = [];
  const entries = await checked(lifecycle, readdir(directory, { withFileTypes: true }));
  for (const entry of entries) {
    throwIfAborted(lifecycle);
    const absolute = join(directory, entry.name);
    const file = relative(root, absolute).split(sep).join('/');
    if (file === '.git') {
      if (!entry.isFile()) throw new Error('Detached checkout .git pointer is not a regular file');
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`Refusing deployment: symbolic link ${file}`);
    if (entry.isDirectory()) {
      files.push(...await checked(lifecycle, listDeploymentFiles(root, lifecycle, absolute)));
    }
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Refusing deployment: unsupported filesystem entry ${file}`);
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

async function verifyParentDirectories(checkout, file, lifecycle) {
  const segments = file.split('/');
  let current = resolve(checkout);
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const entry = await checked(lifecycle, lstat(current));
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Refusing deployment: non-directory or linked parent for ${file}`);
    }
  }
}

async function verifyGitBlob(checkout, entry, lifecycle) {
  const absolute = safeCheckoutPath(checkout, entry.file);
  await checked(lifecycle, verifyParentDirectories(checkout, entry.file, lifecycle));
  let handle;
  try {
    handle = await checkedOpen(
      lifecycle,
      absolute,
      SAFE_READ_FLAGS,
    );
    const fileStat = await checked(lifecycle, handle.stat());
    if (!fileStat.isFile()) throw new Error(`Refusing deployment: non-regular file ${entry.file}`);
    const actualMode = fileStat.mode & 0o100 ? '100755' : '100644';
    if (actualMode !== entry.mode) {
      throw new Error(
        `Deployment file mode for ${entry.file} is ${actualMode}, expected Git mode ${entry.mode}`,
      );
    }
    if (fileStat.size !== entry.size) {
      throw new Error(
        `Deployment file bytes for ${entry.file} have size ${fileStat.size}, expected ${entry.size}`,
      );
    }
    const bytes = await checked(lifecycle, handle.readFile());
    if (bytes.length !== entry.size) {
      throw new Error(`Deployment file bytes changed while reading ${entry.file}`);
    }
    const algorithm = entry.oid.length === 64 ? 'sha256' : 'sha1';
    const oid = createHash(algorithm)
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest('hex');
    if (oid !== entry.oid) {
      throw new Error(`Deployment file blob hash for ${entry.file} does not match reviewed Git object`);
    }
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`Refusing deployment: symbolic link ${entry.file}`);
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function readProjectMetadata(repository, lifecycle) {
  const vercelDirectory = join(repository, '.vercel');
  const projectPath = join(vercelDirectory, 'project.json');
  let directoryStat;
  let sourceStat;
  try {
    directoryStat = await checked(lifecycle, lstat(vercelDirectory));
    sourceStat = await checked(lifecycle, lstat(projectPath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${projectPath} is required to link the reviewed deployment`);
    }
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${vercelDirectory} must be a real directory inside the repository`);
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`${projectPath} must be a regular file, not a link`);
  }
  const resolvedDirectory = await checked(lifecycle, realpath(vercelDirectory));
  if (dirname(resolvedDirectory) !== repository || basename(resolvedDirectory) !== '.vercel') {
    throw new Error(`${projectPath} resolves outside the validated repository metadata directory`);
  }
  let handle;
  let bytes;
  try {
    handle = await checkedOpen(
      lifecycle,
      projectPath,
      SAFE_READ_FLAGS,
    );
    const metadataStat = await checked(lifecycle, handle.stat());
    if (!metadataStat.isFile()) {
      throw new Error(`${projectPath} must be a regular file, not a link`);
    }
    if (metadataStat.size > MAX_PROJECT_METADATA_BYTES) {
      throw new Error(`${projectPath} exceeds the 64 KiB metadata size limit`);
    }
    const resolvedProject = await checked(lifecycle, realpath(projectPath));
    if (dirname(resolvedProject) !== resolvedDirectory || basename(resolvedProject) !== 'project.json') {
      throw new Error(`${projectPath} resolves outside the validated repository metadata directory`);
    }
    bytes = await checked(lifecycle, handle.readFile());
    if (bytes.length !== metadataStat.size) {
      throw new Error(`${projectPath} changed while its validated bytes were read`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${projectPath} is required to link the reviewed deployment`);
    }
    if (error?.code === 'ELOOP') {
      throw new Error(`${projectPath} must be a regular file, not a link`);
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
  let metadata;
  try {
    metadata = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${projectPath} must contain valid JSON`);
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata.orgId !== 'string' ||
      !metadata.orgId.trim() || typeof metadata.projectId !== 'string' ||
      !metadata.projectId.trim()) {
    throw new Error(`${projectPath} must contain non-empty orgId and projectId values`);
  }
  return {
    bytes,
    publicSummary: { orgId: metadata.orgId, projectId: metadata.projectId },
  };
}

async function verifyProjectMetadata(checkout, expectedBytes, lifecycle) {
  const directory = join(checkout, '.vercel');
  const file = join(directory, 'project.json');
  const directoryStat = await checked(lifecycle, lstat(directory));
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Copied .vercel metadata parent is not a regular directory');
  }
  let handle;
  try {
    handle = await checkedOpen(
      lifecycle,
      file,
      SAFE_READ_FLAGS,
    );
    const fileStat = await checked(lifecycle, handle.stat());
    if (!fileStat.isFile()) throw new Error('Copied .vercel/project.json is not a regular file');
    const actualBytes = await checked(lifecycle, handle.readFile());
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error('Copied .vercel/project.json differs from validated source metadata');
    }
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error('Copied .vercel/project.json must not be a symbolic link');
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function verifyDeploymentSource(checkout, manifest, projectMetadata, lifecycle) {
  const expectedFiles = [...manifest.map((entry) => entry.file), '.vercel/project.json'].sort();
  const deploymentFiles = await checked(lifecycle, listDeploymentFiles(checkout, lifecycle));
  compareFileSets(deploymentFiles, expectedFiles);
  const totalBytes = manifest.reduce((total, entry) => total + entry.size, 0) +
    projectMetadata.bytes.length;
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('Refusing deployment: reviewed files and project metadata exceed 64 MiB');
  }
  for (const entry of manifest) {
    await checked(lifecycle, verifyGitBlob(checkout, entry, lifecycle));
  }
  await checked(lifecycle, verifyProjectMetadata(checkout, projectMetadata.bytes, lifecycle));
  throwIfAborted(lifecycle);
  return deploymentFiles;
}

function worktreePaths(output) {
  return output
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => resolve(field.slice('worktree '.length)));
}

async function isRegisteredWorktree(repository, checkout, lifecycle) {
  const output = await runGit(
    repository,
    ['worktree', 'list', '--porcelain', '-z'],
    lifecycle,
    { raw: true, cleanup: true },
  );
  return worktreePaths(output).includes(resolve(checkout));
}

async function removeExactAdministrativeRegistration(repository, checkout, lifecycle) {
  const commonOutput = await runGit(
    repository,
    ['rev-parse', '--git-common-dir'],
    lifecycle,
    { cleanup: true },
  );
  const commonDirectory = await realpath(
    isAbsolute(commonOutput) ? commonOutput : resolve(repository, commonOutput),
  );
  const registrations = join(commonDirectory, 'worktrees');
  let entries;
  try {
    entries = await readdir(registrations, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const registration = resolve(registrations, entry.name);
    if (dirname(registration) !== resolve(registrations)) continue;
    const gitdirFile = join(registration, 'gitdir');
    let gitdirStat;
    try {
      gitdirStat = await lstat(gitdirFile);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!gitdirStat.isFile() || gitdirStat.isSymbolicLink()) continue;
    const gitdir = (await readFile(gitdirFile, 'utf8')).trim();
    const registeredGitFile = isAbsolute(gitdir) ? resolve(gitdir) : resolve(registration, gitdir);
    if (dirname(registeredGitFile) !== resolve(checkout) || basename(registeredGitFile) !== '.git') {
      continue;
    }
    await rm(registration, { recursive: true, force: true });
  }
}

async function cleanupTemporaryWorktree(
  repository,
  temporaryRoot,
  checkout,
  worktreeAttempted,
  lifecycle,
  temporaryParent,
) {
  if (!temporaryRoot) return;
  lifecycle.cleaning = true;
  assertOwnedTemporaryPaths(temporaryRoot, checkout, temporaryParent);
  if (worktreeAttempted && await isRegisteredWorktree(repository, checkout, lifecycle)) {
    try {
      await runGit(
        repository,
        ['worktree', 'remove', '--force', '--force', checkout],
        lifecycle,
        { cleanup: true },
      );
    } catch {
      await removeExactAdministrativeRegistration(repository, checkout, lifecycle);
    }
  }
  if (worktreeAttempted && await isRegisteredWorktree(repository, checkout, lifecycle)) {
    await removeExactAdministrativeRegistration(repository, checkout, lifecycle);
  }
  if (await isRegisteredWorktree(repository, checkout, lifecycle)) {
    throw new Error(`Failed to remove exact temporary worktree registration: ${checkout}`);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function combineErrors(primary, secondary, message) {
  if (!primary) return secondary;
  const combined = new AggregateError([primary, secondary], message);
  combined.exitCode = primary.exitCode || secondary.exitCode || 1;
  return combined;
}

export async function deployReviewedVercel({
  repository,
  reviewedSha,
  prod = false,
  onPhase = null,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
}) {
  if (typeof reviewedSha !== 'string' || !FULL_COMMIT_SHA.test(reviewedSha)) {
    throw new Error('reviewedSha must be a full commit SHA');
  }
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 50 || shutdownGraceMs > 60_000) {
    throw new Error('shutdownGraceMs must be an integer from 50 through 60000');
  }
  const normalizedSha = reviewedSha.toLowerCase();
  const lifecycle = {
    child: null,
    cleaning: false,
    controller: new AbortController(),
    shutdownGraceMs,
    signal: null,
  };
  const recordSignal = (signal) => {
    lifecycle.signal ||= signal;
    if (!lifecycle.controller.signal.aborted) lifecycle.controller.abort();
    if (!lifecycle.cleaning && childIsRunning(lifecycle.child)) {
      signalOwnedChild(lifecycle.child, signal);
      armChildShutdown(lifecycle, lifecycle.child);
    }
  };
  const onSigint = () => recordSignal('SIGINT');
  const onSigterm = () => recordSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  let repositoryPath = null;
  let temporaryParent = null;
  let temporaryRoot = null;
  let checkout = null;
  let worktreeAttempted = false;
  let summary;
  let operationError = null;
  let cleanupError = null;
  try {
    repositoryPath = await checked(lifecycle, realpath(resolve(repository)));
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
    if (repositoryHead.toLowerCase() !== normalizedSha) {
      throw new Error(`Repository HEAD ${repositoryHead} does not equal reviewed SHA ${normalizedSha}`);
    }
    if (localMain.toLowerCase() !== normalizedSha) {
      throw new Error(`Local main ${localMain} does not equal reviewed SHA ${normalizedSha}`);
    }
    if (trackedStatus) throw new Error('Repository has uncommitted tracked changes');

    const projectMetadata = await readProjectMetadata(repositoryPath, lifecycle);
    const manifest = await readGitManifest(repositoryPath, normalizedSha, lifecycle);
    temporaryParent = await checked(lifecycle, realpath(tmpdir()));
    throwIfAborted(lifecycle);
    temporaryRoot = await mkdtemp(join(temporaryParent, TEMP_PREFIX));
    checkout = join(temporaryRoot, 'checkout');
    assertOwnedTemporaryPaths(temporaryRoot, checkout, temporaryParent);
    throwIfAborted(lifecycle);
    worktreeAttempted = true;
    await runGit(
      repositoryPath,
      ['worktree', 'add', '--detach', checkout, normalizedSha],
      lifecycle,
    );

    const checkoutSha = (await runGit(checkout, ['rev-parse', 'HEAD'], lifecycle)).toLowerCase();
    if (checkoutSha !== normalizedSha) {
      throw new Error(`Detached checkout ${checkoutSha} does not equal reviewed SHA ${normalizedSha}`);
    }
    const projectDirectory = join(checkout, '.vercel');
    await checked(lifecycle, mkdir(projectDirectory, { recursive: false, mode: 0o700 }));
    await checked(lifecycle, writeFile(
      join(projectDirectory, 'project.json'),
      projectMetadata.bytes,
      { flag: 'wx', mode: 0o600 },
    ));
    let deploymentFiles = await verifyDeploymentSource(
      checkout,
      manifest,
      projectMetadata,
      lifecycle,
    );

    if (prod) {
      if (onPhase) {
        throwIfAborted(lifecycle);
        await checked(lifecycle, Promise.resolve(onPhase('before-provider', {
          signal: lifecycle.controller.signal,
        })));
      }
      deploymentFiles = await verifyDeploymentSource(
        checkout,
        manifest,
        projectMetadata,
        lifecycle,
      );
      const finalCheckoutSha = (await runGit(checkout, ['rev-parse', 'HEAD'], lifecycle)).toLowerCase();
      if (finalCheckoutSha !== normalizedSha) {
        throw new Error(`Deployment checkout moved from reviewed SHA ${normalizedSha}`);
      }
      const vercelBinary = join(repositoryPath, 'node_modules', '.bin', 'vercel');
      await checked(lifecycle, access(vercelBinary, constants.X_OK));
      throwIfAborted(lifecycle);
      await runProcess(
        vercelBinary,
        ['--cwd', checkout, '--prod', '--yes'],
        {
          cwd: repositoryPath,
          inherit: true,
          lifecycle,
          ownedProcessGroup: true,
        },
      );
      throwIfAborted(lifecycle);
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
      if (repositoryPath && temporaryRoot && checkout) {
        await cleanupTemporaryWorktree(
          repositoryPath,
          temporaryRoot,
          checkout,
          worktreeAttempted,
          lifecycle,
          temporaryParent,
        );
      }
    } catch (error) {
      cleanupError = error;
    }
    if (!lifecycle.signal) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }

  if (lifecycle.signal) {
    operationError = interruptionError(lifecycle);
  }
  if (cleanupError) {
    operationError = combineErrors(
      operationError,
      cleanupError,
      `${operationError?.message || 'Deployment operation failed'}; cleanup also failed`,
    );
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
