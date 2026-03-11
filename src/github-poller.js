const https = require('https');
const { matchesWatchPatterns, isConfigOnlyCommit } = require('./config');

/**
 * Auto-commit message prefix used by this extension.
 * Commits with this prefix are skipped to prevent self-triggering loops.
 */
const AUTO_COMMIT_PREFIX = 'auto(';

/**
 * Makes a GitHub API request.
 * @param {string} endpoint - API path (e.g., "/repos/owner/repo/commits")
 * @param {string} token - GitHub personal access token
 * @param {object} [queryParams] - Optional query parameters
 * @returns {Promise<object>}
 */
function githubApi(endpoint, token, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const query = Object.entries(queryParams)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const fullPath = query ? `${endpoint}?${query}` : endpoint;

    const options = {
      hostname: 'api.github.com',
      path: fullPath,
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'antigravity-github-trigger',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse GitHub response: ${e.message}`));
          }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('GitHub API request timeout'));
    });
    req.end();
  });
}

/**
 * Fetches the list of files changed in a specific commit.
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha
 * @param {string} token
 * @returns {Promise<string[]>} Array of file paths
 */
async function getCommitFiles(owner, repo, sha, token) {
  const commit = await githubApi(`/repos/${owner}/${repo}/commits/${sha}`, token);
  return (commit.files || []).map(f => f.filename);
}

/**
 * Fetches recent commits for a branch since a given SHA.
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {string} token
 * @param {string|null} sinceSha - Last processed commit SHA
 * @returns {Promise<object[]>} Array of commit objects (newest first)
 */
async function getRecentCommits(owner, repo, branch, token, sinceSha) {
  const commits = await githubApi(
    `/repos/${owner}/${repo}/commits`,
    token,
    { sha: branch, per_page: 10 }
  );

  if (!sinceSha) {
    // First run — return only the latest commit
    return commits.slice(0, 1);
  }

  // Return all commits up to (but not including) the last processed one
  const newCommits = [];
  for (const commit of commits) {
    if (commit.sha === sinceSha) break;
    newCommits.push(commit);
  }
  return newCommits;
}

/**
 * Polls a single trigger for new commits that affect watched files.
 * @param {object} trigger - Trigger config object
 * @param {string} token - GitHub token
 * @param {object} state - Extension global state for tracking last SHA
 * @returns {Promise<object|null>} Task info if triggered, null otherwise
 */
async function pollTrigger(trigger, token, state) {
  const { id, owner, repo, branch, watchFiles } = trigger;
  const stateKey = `lastSha_${id}`;
  const lastSha = trigger.lastProcessedCommitSha || state.get(stateKey);

  const commits = await getRecentCommits(owner, repo, branch, token, lastSha);

  if (commits.length === 0) {
    return null;
  }

  // Check each new commit (oldest first for proper ordering)
  for (const commit of commits.reverse()) {
    const commitMessage = commit.commit?.message || '';

    // Skip auto-commits made by this extension (self-trigger prevention)
    if (commitMessage.startsWith(AUTO_COMMIT_PREFIX)) {
      console.log(`[antigravity-trigger] Skipping self-commit: ${commitMessage.substring(0, 60)}`);
      continue;
    }

    const files = await getCommitFiles(owner, repo, commit.sha, token);

    // Skip config-only commits (self-trigger prevention)
    if (isConfigOnlyCommit(files)) {
      continue;
    }

    // Check if any changed files match watch patterns
    const matchedFiles = files.filter(f => matchesWatchPatterns(f, watchFiles));

    if (matchedFiles.length > 0) {
      // Update last processed SHA
      await state.update(stateKey, commit.sha);

      return {
        triggerId: id,
        owner,
        repo,
        branch,
        commitSha: commit.sha,
        commitMessage: commit.commit?.message || 'No message',
        commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
        author: commit.commit?.author?.name || 'Unknown',
        matchedFiles,
        allChangedFiles: files,
        prompt: trigger.prompt,
        autoPush: trigger.autoPush !== false
      };
    }
  }

  // No matching changes, but update SHA to latest to avoid re-checking
  if (commits.length > 0) {
    const latestSha = commits[commits.length - 1].sha;
    await state.update(stateKey, latestSha);
  }

  return null;
}

/**
 * Polls all triggers in the config.
 * @param {object} config - Full trigger config
 * @param {string} token - GitHub token  
 * @param {object} state - Extension global state
 * @returns {Promise<object[]>} Array of triggered tasks
 */
async function pollAllTriggers(config, token, state) {
  if (!config.enabled) return [];

  const triggers = config.triggers || [];
  const results = [];

  for (const trigger of triggers) {
    try {
      const result = await pollTrigger(trigger, token, state);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      console.error(`[antigravity-trigger] Error polling ${trigger.id}: ${err.message}`);
    }
  }

  return results;
}

module.exports = {
  githubApi,
  getCommitFiles,
  getRecentCommits,
  pollTrigger,
  pollAllTriggers
};
