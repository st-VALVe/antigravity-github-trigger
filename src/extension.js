const vscode = require('vscode');
const { loadTriggerConfig, getGitHubToken, saveTriggerConfig } = require('./config');
const { pollAllTriggers } = require('./github-poller');
const { buildPrompt, sendToChat } = require('./chat-sender');

/** @type {NodeJS.Timeout|null} */
let pollTimer = null;

/** @type {boolean} */
let isEnabled = true;

/** @type {string|null} */
let lastPollStatus = 'Not yet polled';

/** @type {Date|null} */
let lastPollTime = null;

/** @type {vscode.ExtensionContext} */
let extensionContext;

/** @type {vscode.StatusBarItem} */
let statusBarItem;

/**
 * Extension activation.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  extensionContext = context;
  console.log('[antigravity-trigger] Extension activated');

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity-trigger.status';
  updateStatusBar('idle');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-trigger.enable', () => {
      isEnabled = true;
      startPolling();
      vscode.window.showInformationMessage('Antigravity GitHub Trigger: Enabled');
      updateStatusBar('idle');
    }),

    vscode.commands.registerCommand('antigravity-trigger.disable', () => {
      isEnabled = false;
      stopPolling();
      vscode.window.showInformationMessage('Antigravity GitHub Trigger: Disabled');
      updateStatusBar('disabled');
    }),

    vscode.commands.registerCommand('antigravity-trigger.status', () => {
      const msg = [
        `Status: ${isEnabled ? 'Enabled' : 'Disabled'}`,
        `Last poll: ${lastPollTime ? lastPollTime.toLocaleTimeString() : 'Never'}`,
        `Result: ${lastPollStatus}`
      ].join('\n');
      vscode.window.showInformationMessage(msg);
    }),

    vscode.commands.registerCommand('antigravity-trigger.triggerNow', () => {
      pollOnce();
    })
  );

  // Start polling on activation
  startPolling();
}

/**
 * Starts the polling timer.
 */
function startPolling() {
  stopPolling();

  if (!isEnabled) return;

  const { config } = loadTriggerConfig();
  const intervalSeconds = config?.pollIntervalSeconds || 60;

  console.log(`[antigravity-trigger] Starting polling every ${intervalSeconds}s`);
  updateStatusBar('idle');

  // Initial poll after a short delay
  setTimeout(() => pollOnce(), 5000);

  // Set up recurring poll
  pollTimer = setInterval(() => pollOnce(), intervalSeconds * 1000);
}

/**
 * Stops the polling timer.
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Performs a single poll cycle.
 */
async function pollOnce() {
  if (!isEnabled) return;

  const { config, configPath, error: configError } = loadTriggerConfig();
  if (configError || !config) {
    lastPollStatus = configError || 'No config';
    lastPollTime = new Date();
    // Not an error — config might simply not exist in this workspace
    return;
  }

  if (!config.enabled) {
    lastPollStatus = 'Disabled in config';
    lastPollTime = new Date();
    updateStatusBar('disabled');
    return;
  }

  const token = getGitHubToken();
  if (!token) {
    lastPollStatus = 'No GitHub token found in mcp_config.json';
    lastPollTime = new Date();
    updateStatusBar('error');
    console.error('[antigravity-trigger] No GitHub token found');
    return;
  }

  updateStatusBar('polling');

  try {
    const state = extensionContext.globalState;
    const triggeredTasks = await pollAllTriggers(config, token, state);

    lastPollTime = new Date();

    if (triggeredTasks.length === 0) {
      lastPollStatus = 'No new changes detected';
      updateStatusBar('idle');
      return;
    }

    // Process triggered tasks (one at a time to avoid chat conflicts)
    for (const task of triggeredTasks) {
      // Check cooldown
      const cooldownMinutes = config.cooldownMinutes || 10;
      const cooldownKey = `cooldown_${task.triggerId}`;
      const lastTriggerTime = state.get(cooldownKey);

      if (lastTriggerTime) {
        const elapsed = Date.now() - lastTriggerTime;
        if (elapsed < cooldownMinutes * 60 * 1000) {
          console.log(`[antigravity-trigger] Skipping ${task.triggerId}: cooldown active (${Math.round((cooldownMinutes * 60 * 1000 - elapsed) / 1000)}s remaining)`);
          continue;
        }
      }

      // Build and send prompt
      const prompt = buildPrompt(task);
      console.log(`[antigravity-trigger] Triggering task: ${task.triggerId}`);
      updateStatusBar('triggered');

      const sent = await sendToChat(prompt);

      if (sent) {
        // Update cooldown
        await state.update(cooldownKey, Date.now());

        // Add pending entry to task log
        if (!config.taskLog) config.taskLog = [];
        config.taskLog.push({
          triggerId: task.triggerId,
          status: 'triggered',
          triggerCommitSha: task.commitSha,
          resultCommitSha: null,
          triggeredAt: new Date().toISOString(),
          completedAt: null
        });

        // Update lastProcessedCommitSha on the trigger
        const trigger = config.triggers.find(t => t.id === task.triggerId);
        if (trigger) {
          trigger.lastProcessedCommitSha = task.commitSha;
        }

        saveTriggerConfig(configPath, config);

        lastPollStatus = `Triggered: ${task.triggerId} (${task.matchedFiles.length} files)`;

        vscode.window.showInformationMessage(
          `🤖 Antigravity task triggered: ${task.triggerId}\n` +
          `Files: ${task.matchedFiles.join(', ')}`
        );
      } else {
        lastPollStatus = `Failed to send task: ${task.triggerId}`;
        updateStatusBar('error');
      }
    }

    updateStatusBar('idle');
  } catch (err) {
    lastPollStatus = `Error: ${err.message}`;
    lastPollTime = new Date();
    updateStatusBar('error');
    console.error(`[antigravity-trigger] Poll error: ${err.message}`);
  }
}

/**
 * Updates the status bar item.
 * @param {'idle'|'polling'|'triggered'|'disabled'|'error'} state
 */
function updateStatusBar(state) {
  switch (state) {
    case 'idle':
      statusBarItem.text = '$(eye) AG Trigger';
      statusBarItem.tooltip = 'Antigravity GitHub Trigger: Watching...';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'polling':
      statusBarItem.text = '$(sync~spin) AG Trigger';
      statusBarItem.tooltip = 'Polling GitHub...';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'triggered':
      statusBarItem.text = '$(rocket) AG Triggered!';
      statusBarItem.tooltip = 'Task sent to Antigravity';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
    case 'disabled':
      statusBarItem.text = '$(circle-slash) AG Trigger Off';
      statusBarItem.tooltip = 'Antigravity GitHub Trigger: Disabled';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'error':
      statusBarItem.text = '$(error) AG Trigger';
      statusBarItem.tooltip = `Error: ${lastPollStatus}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
  }
}

/**
 * Extension deactivation.
 */
function deactivate() {
  stopPolling();
  console.log('[antigravity-trigger] Extension deactivated');
}

module.exports = { activate, deactivate };
