const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

// Default config path
const CONFIG_FILENAME = '.antigravity-triggers.json';
const MCP_CONFIG_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.gemini', 'antigravity', 'mcp_config.json'
);

/**
 * Reads and parses the trigger config from the workspace root.
 * @param {string} [workspacePath] - Override workspace path
 * @returns {{ config: object|null, configPath: string|null, error: string|null }}
 */
function loadTriggerConfig(workspacePath) {
  const wsPath = workspacePath || getWorkspacePath();
  if (!wsPath) {
    return { config: null, configPath: null, error: 'No workspace folder open' };
  }

  const configPath = path.join(wsPath, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return { config: null, configPath, error: `Config file not found: ${configPath}` };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return { config, configPath, error: null };
  } catch (err) {
    return { config: null, configPath, error: `Failed to parse config: ${err.message}` };
  }
}

/**
 * Reads the GitHub token from the MCP config file.
 * @returns {string|null}
 */
function getGitHubToken() {
  try {
    if (!fs.existsSync(MCP_CONFIG_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8');
    const mcpConfig = JSON.parse(raw);
    return mcpConfig?.mcpServers?.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN || null;
  } catch {
    return null;
  }
}

/**
 * Gets the first workspace folder path.
 * @returns {string|null}
 */
function getWorkspacePath() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

/**
 * Updates the trigger config file on disk.
 * @param {string} configPath
 * @param {object} config
 */
function saveTriggerConfig(configPath, config) {
  const json = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(configPath, json, 'utf-8');
}

/**
 * Checks if a file path matches any of the glob patterns.
 * @param {string} filePath - The file path from GitHub (e.g., "src/config/index.js")
 * @param {string[]} patterns - Glob patterns (e.g., ["src/config/**", "docs/*.md"])
 * @returns {boolean}
 */
function matchesWatchPatterns(filePath, patterns) {
  return patterns.some(pattern => minimatch(filePath, pattern, { dot: true }));
}

/**
 * Checks if a commit only modifies the trigger config file.
 * Used to prevent self-triggering loops.
 * @param {string[]} changedFiles
 * @returns {boolean}
 */
function isConfigOnlyCommit(changedFiles) {
  return changedFiles.length > 0 &&
    changedFiles.every(f => f === CONFIG_FILENAME || f.endsWith('/' + CONFIG_FILENAME));
}

module.exports = {
  CONFIG_FILENAME,
  MCP_CONFIG_PATH,
  loadTriggerConfig,
  getGitHubToken,
  getWorkspacePath,
  saveTriggerConfig,
  matchesWatchPatterns,
  isConfigOnlyCommit
};
