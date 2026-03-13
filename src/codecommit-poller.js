const { execFile } = require('child_process');
const { matchesWatchPatterns, isConfigOnlyCommit } = require('./config');

/**
 * Default trigger tag. Only commits containing this tag in their message
 * will activate the trigger. All other commits are silently ignored.
 */
const DEFAULT_TRIGGER_TAG = '[ag]';

/**
 * Runs a git command with CodeCommit SSH credentials.
 * @param {string[]} args - git command arguments
 * @param {object} opts - { sshKeyPath, sshUser, cwd }
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
        reject(new Error(`git ${args[0]} failed: ${err.message}\n${stderr}`));
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
  // Format: "sha\trefs/heads/branch"
  const match = output.match(/^([0-9a-f]{40})\s/);
  return match ? match[1] : null;
}

/**
 * Gets commit details (message, author, files) for commits between two SHAs.
 * Uses a shallow clone to /tmp to avoid requiring the repo to be locally available.
 * @param {string} remoteUrl
 * @param {string} branch
 * @param {string} latestSha
 * @param {string|null} sinceSha
 * @param {object} sshOpts
 * @returns {Promise<object[]>} Array of { sha, message, author, files }
 */
async function getCommitDetails(remoteUrl, branch, latestSha, sinceSha, sshOpts) {
  // Use a temp shallow clone to read commit data
  const repoName = remoteUrl.split('/').pop();
  const cloneDir = `/tmp/ag-cc-poll-${repoName}`;

  try {
    // Clone or fetch
    const fs = require('fs');
    if (fs.existsSync(`${cloneDir}/.git`)) {
      await gitCmd(['fetch', 'origin', branch, '--depth=20'], { ...sshOpts, cwd: cloneDir });
      await gitCmd(['reset', '--hard', `origin/${branch}`], { ...sshOpts, cwd: cloneDir });
    } else {
      // Clean up and clone
      try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
      await gitCmd(
        ['clone', '--depth=20', '--branch', branch, '--single-branch', remoteUrl, cloneDir],
        sshOpts
      );
    }

    // Get commit log
    let logArgs;
    if (sinceSha) {
      logArgs = ['log', `${sinceSha}..HEAD`, '--format=%H|||%s|||%an', '--name-only'];
    } else {
      // First run — only latest commit
      logArgs = ['log', '-1', '--format=%H|||%s|||%an', '--name-only'];
    }

    const logOutput = await gitCmd(logArgs, { cwd: cloneDir });
    if (!logOutput) return [];

    return parseGitLog(logOutput);
  } catch (err) {
    // If sinceSha is not in the shallow clone, fall back to latest only
    if (err.message.includes('bad revision') || err.message.includes('unknown revision')) {
      const logOutput = await gitCmd(
        ['log', '-1', '--format=%H|||%s|||%an', '--name-only'],
        { cwd: cloneDir }
      );
      if (!logOutput) return [];
      return parseGitLog(logOutput);
    }
    throw err;
  }
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
 * Polls a single CodeCommit trigger for new [ag] commits.
 * @param {object} trigger - Trigger config object (with platform: "codecommit")
 * @param {object} state - Extension global state for tracking last SHA
 * @returns {Promise<object|null>} Task info if triggered, null otherwise
 */
async function pollCodeCommitTrigger(trigger, state) {
  const { id, repo, branch, watchFiles } = trigger;
  const triggerTag = trigger.triggerTag || DEFAULT_TRIGGER_TAG;
  const stateKey = `lastSha_${id}`;
  const lastSha = state.get(stateKey) || trigger.lastProcessedCommitSha;

  const sshOpts = {
    sshKeyPath: trigger.sshKeyPath
  };

  const remoteUrl = buildRemoteUrl(trigger);

  // Quick check: has the remote HEAD changed?
  const remoteSha = await getRemoteHeadSha(remoteUrl, branch, sshOpts);
  if (!remoteSha) {
    return null;
  }

  if (remoteSha === lastSha) {
    // No new commits
    return null;
  }

  // Fetch commit details
  const commits = await getCommitDetails(remoteUrl, branch, remoteSha, lastSha, sshOpts);
  if (commits.length === 0) {
    await state.update(stateKey, remoteSha);
    return null;
  }

  // Process commits oldest-first
  for (const commit of commits.reverse()) {
    // WHITELIST: only process commits with the trigger tag
    if (!commit.message.includes(triggerTag)) {
      await state.update(stateKey, commit.sha);
      continue;
    }

    console.log(`[antigravity-trigger] CodeCommit tag "${triggerTag}" found in: ${commit.message.substring(0, 80)}`);

    // Filter by watchFiles if configured
    let matchedFiles = commit.files;
    if (watchFiles && watchFiles.length > 0) {
      matchedFiles = commit.files.filter(f => matchesWatchPatterns(f, watchFiles));
      if (matchedFiles.length === 0) {
        console.log(`[antigravity-trigger] Tag found but no files matched watchFiles patterns`);
        await state.update(stateKey, commit.sha);
        continue;
      }
    }

    // Update last processed SHA
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

  // No tagged commits found, but update SHA to latest
  await state.update(stateKey, remoteSha);
  return null;
}

/**
 * Polls all CodeCommit triggers.
 * @param {object[]} triggers - CodeCommit trigger configs
 * @param {object} state - Extension global state
 * @returns {Promise<object[]>} Array of triggered tasks
 */
async function pollAllCodeCommitTriggers(triggers, state) {
  const results = [];

  for (const trigger of triggers) {
    try {
      const result = await pollCodeCommitTrigger(trigger, state);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      console.error(`[antigravity-trigger] Error polling CodeCommit ${trigger.id}: ${err.message}`);
    }
  }

  return results;
}

module.exports = {
  gitCmd,
  getRemoteHeadSha,
  getCommitDetails,
  parseGitLog,
  buildRemoteUrl,
  pollCodeCommitTrigger,
  pollAllCodeCommitTriggers
};
