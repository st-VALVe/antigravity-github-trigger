const { execFile } = require('child_process');
const { matchesWatchPatterns } = require('./config');

const DEFAULT_TRIGGER_TAG = '[ag]';

/** @type {Function} */
let _log = (...args) => console.log('[antigravity-trigger]', ...args);

/**
 * Sets the logging function (called from extension.js).
 * @param {Function} logFn
 */
function setLogger(logFn) {
  _log = logFn;
}

/**
 * Runs a git command with CodeCommit SSH credentials.
 * @param {string[]} args - git command arguments
 * @param {object} opts - { sshKeyPath, cwd }
 * @returns {Promise<string>} stdout
 */
function gitCmd(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (opts.sshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${opts.sshKeyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    }

    execFile('git', args, {
      env,
      cwd: opts.cwd || process.cwd(),
      timeout: 30000
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args[0]} failed: ${err.message}\nstderr: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Gets the latest commit SHA on a remote branch via ls-remote.
 * @param {string} remoteUrl - SSH URL to CodeCommit repo
 * @param {string} branch - Branch name
 * @param {object} sshOpts - { sshKeyPath }
 * @returns {Promise<string|null>} SHA or null
 */
async function getRemoteHeadSha(remoteUrl, branch, sshOpts) {
  const output = await gitCmd(
    ['ls-remote', '--heads', remoteUrl, `refs/heads/${branch}`],
    sshOpts
  );
  if (!output) return null;
  const match = output.match(/^([0-9a-f]{40})\s/);
  return match ? match[1] : null;
}

/**
 * Fetches latest commits and reads log from the local workspace repo.
 * @param {string} workspacePath - Local repo path
 * @param {string} branch - Branch name
 * @param {string|null} sinceSha - Last processed SHA
 * @param {object} sshOpts - { sshKeyPath }
 * @returns {Promise<object[]>} Array of { sha, message, author, files }
 */
async function getCommitDetailsFromWorkspace(workspacePath, branch, sinceSha, sshOpts) {
  const gitOpts = { ...sshOpts, cwd: workspacePath };

  await gitCmd(['fetch', 'origin', branch], gitOpts);

  let logArgs;
  if (sinceSha) {
    logArgs = ['log', `${sinceSha}..origin/${branch}`, '--format=%H|||%s|||%an', '--name-only'];
  } else {
    logArgs = ['log', '-1', `origin/${branch}`, '--format=%H|||%s|||%an', '--name-only'];
  }

  const logOutput = await gitCmd(logArgs, { cwd: workspacePath });
  if (!logOutput) return [];

  return parseGitLog(logOutput);
}

/**
 * Parses git log output with format %H|||%s|||%an and --name-only.
 * @param {string} output
 * @returns {object[]}
 */
function parseGitLog(output) {
  const commits = [];
  let current = null;

  for (const line of output.split('\n')) {
    if (line.includes('|||')) {
      const [sha, message, author] = line.split('|||');
      if (current) commits.push(current);
      current = { sha, message, author, files: [] };
    } else if (current && line.trim()) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);

  return commits;
}

/**
 * Builds the SSH remote URL for a CodeCommit trigger.
 * @param {object} trigger
 * @returns {string}
 */
function buildRemoteUrl(trigger) {
  const region = trigger.region || 'us-east-1';
  return `ssh://${trigger.sshUser}@git-codecommit.${region}.amazonaws.com/v1/repos/${trigger.repo}`;
}

/**
 * Polls a single CodeCommit trigger for new tagged commits.
 * Uses the local workspace repo for fetching — no temp clone needed.
 * @param {object} trigger - Trigger config with platform: "codecommit"
 * @param {object} state - Extension global state for tracking last SHA
 * @param {string} workspacePath - Local workspace repo path
 * @returns {Promise<object|null>} Task info if triggered, null otherwise
 */
async function pollCodeCommitTrigger(trigger, state, workspacePath) {
  const { id, repo, branch, watchFiles } = trigger;
  const triggerTag = trigger.triggerTag || DEFAULT_TRIGGER_TAG;
  const stateKey = `lastSha_${id}`;
  const lastSha = state.get(stateKey) || trigger.lastProcessedCommitSha;

  const sshOpts = { sshKeyPath: trigger.sshKeyPath };
  const remoteUrl = buildRemoteUrl(trigger);

  // Quick check: has the remote HEAD changed?
  const remoteSha = await getRemoteHeadSha(remoteUrl, branch, sshOpts);
  if (!remoteSha || remoteSha === lastSha) {
    return null;
  }

  _log(`CodeCommit ${id}: new commits detected (${remoteSha.substring(0, 7)})`);

  // Fetch and read commit log from the local workspace repo
  const commits = await getCommitDetailsFromWorkspace(workspacePath, branch, lastSha, sshOpts);
  if (commits.length === 0) {
    await state.update(stateKey, remoteSha);
    return null;
  }

  // Process commits oldest-first
  for (const commit of commits.reverse()) {
    if (!commit.message.includes(triggerTag)) {
      await state.update(stateKey, commit.sha);
      continue;
    }

    _log(`CodeCommit ${id}: tag "${triggerTag}" found in ${commit.sha.substring(0, 7)}`);

    // Filter by watchFiles if configured
    let matchedFiles = commit.files;
    if (watchFiles && watchFiles.length > 0) {
      matchedFiles = commit.files.filter(f => matchesWatchPatterns(f, watchFiles));
      if (matchedFiles.length === 0) {
        await state.update(stateKey, commit.sha);
        continue;
      }
    }

    await state.update(stateKey, commit.sha);

    const region = trigger.region || 'us-east-1';
    return {
      triggerId: id,
      owner: 'codecommit',
      repo,
      branch,
      commitSha: commit.sha,
      commitMessage: commit.message,
      commitUrl: `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repo}/commit/${commit.sha}`,
      author: commit.author,
      matchedFiles,
      allChangedFiles: matchedFiles,
      prompt: trigger.prompt,
      autoPush: trigger.autoPush !== false,
      platform: 'codecommit',
      sshKeyPath: trigger.sshKeyPath,
      sshUser: trigger.sshUser,
      region
    };
  }

  // No tagged commits found
  await state.update(stateKey, remoteSha);
  return null;
}

/**
 * Polls all CodeCommit triggers.
 * @param {object[]} triggers - CodeCommit trigger configs
 * @param {object} state - Extension global state
 * @param {string} workspacePath - Local workspace repo path
 * @returns {Promise<object[]>} Array of triggered tasks
 */
async function pollAllCodeCommitTriggers(triggers, state, workspacePath) {
  const results = [];

  for (const trigger of triggers) {
    try {
      const result = await pollCodeCommitTrigger(trigger, state, workspacePath);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      _log(`ERROR polling CodeCommit ${trigger.id}: ${err.message}`);
    }
  }

  return results;
}

module.exports = {
  setLogger,
  gitCmd,
  getRemoteHeadSha,
  getCommitDetailsFromWorkspace,
  parseGitLog,
  buildRemoteUrl,
  pollCodeCommitTrigger,
  pollAllCodeCommitTriggers
};
