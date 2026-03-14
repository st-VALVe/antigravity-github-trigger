const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Config file for WebSocket dispatch
const CONFIG_FILENAME = '.antigravity-dispatch.json';

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
 * Reads and parses the dispatch config from the workspace root.
 *
 * Config format (.antigravity-dispatch.json):
 * {
 *   "enabled": true,
 *   "dispatchServer": "wss://dispatch.serveyou.app",
 *   "authToken": "<per-user-token>",
 *   "prompt": "Read the task: {{task}}. Execute it. ...",
 *   "rejectUnauthorized": true
 * }
 *
 * @returns {{ config: object|null, error: string|null }}
 */
function loadDispatchConfig() {
  const wsPath = getWorkspacePath();
  if (!wsPath) {
    return { config: null, error: 'No workspace folder open' };
  }

  const configPath = path.join(wsPath, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return { config: null, error: `Config file not found: ${CONFIG_FILENAME}` };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return { config, error: null };
  } catch (err) {
    return { config: null, error: `Failed to parse config: ${err.message}` };
  }
}

module.exports = {
  CONFIG_FILENAME,
  loadDispatchConfig,
  getWorkspacePath,
};
