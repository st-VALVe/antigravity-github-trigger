const vscode = require('vscode');
const https = require('https');
const { execFile } = require('child_process');
const { loadTriggerConfig, getGitHubToken, saveTriggerConfig, getWorkspaceRemote } = require('./config');
const { pollAllTriggers } = require('./github-poller');
const { pollAllCodeCommitTriggers } = require('./codecommit-poller');
const { buildPrompt, sendToChat } = require('./chat-sender');

/**
 * Runs `git pull --rebase` in the workspace to sync with remote changes
 * (e.g., commits pushed by Aider agent in GitHub Actions).
 * @param {Function} log - Logger function
 * @returns {Promise<void>}
 */
function gitPullWorkspace(log) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    log('git pull: no workspace folder found, skipping');
    return Promise.resolve();
  }

  const cwd = workspaceFolders[0].uri.fsPath;
  log(`git pull --rebase in ${cwd}`);

  return new Promise((resolve) => {
    execFile('git', ['pull', '--rebase'], { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        log(`git pull warning: ${err.message}`);
        // Don't block task execution on pull failure
      } else {
        const output = (stdout || '').trim();
        if (output && output !== 'Already up to date.') {
          log(`git pull: ${output}`);
        }
      }
      resolve();
    });
  });
}

/** @type {NodeJS.Timeout|null} */
let pollTimer = null;

/** @type {boolean} */
let isEnabled = false;

/** @type {string|null} */
let lastPollStatus = 'Not yet polled';

/** @type {Date|null} */
let lastPollTime = null;

/** @type {vscode.ExtensionContext} */
let extensionContext;

/** @type {vscode.StatusBarItem} */
let statusBarItem;

/** @type {vscode.OutputChannel} */
let outputChannel;

/**
 * Logs a message to the Output Channel (visible in Output tab).
 * @param {string} msg
 */
function log(msg) {
  const ts = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

/**
 * Extension activation.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  extensionContext = context;

  // Create output channel for visible logging
  outputChannel = vscode.window.createOutputChannel('Antigravity Trigger');
  context.subscriptions.push(outputChannel);
  log('Extension activated');

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity-trigger.toggle';
  updateStatusBar('disabled');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-trigger.toggle', () => {
      if (isEnabled) {
        isEnabled = false;
        stopPolling();
        log('Disabled by user');
        vscode.window.showInformationMessage('Antigravity GitHub Trigger: Disabled');
        updateStatusBar('disabled');
      } else {
        isEnabled = true;
        log('Enabled by user');
        startPolling();
        vscode.window.showInformationMessage('Antigravity GitHub Trigger: Enabled');
        updateStatusBar('idle');
      }
    }),

    vscode.commands.registerCommand('antigravity-trigger.enable', () => {
      isEnabled = true;
      startPolling();
      log('Enabled via command');
      vscode.window.showInformationMessage('Antigravity GitHub Trigger: Enabled');
      updateStatusBar('idle');
    }),

    vscode.commands.registerCommand('antigravity-trigger.disable', () => {
      isEnabled = false;
      stopPolling();
      log('Disabled via command');
      vscode.window.showInformationMessage('Antigravity GitHub Trigger: Disabled');
      updateStatusBar('disabled');
    }),

    vscode.commands.registerCommand('antigravity-trigger.status', () => {
      const msg = [
        `Status: ${isEnabled ? 'Enabled' : 'Disabled'}`,
        `Last poll: ${lastPollTime ? lastPollTime.toLocaleTimeString() : 'Never'}`,
        `Result: ${lastPollStatus}`
      ].join(' | ');
      log(`Status check: ${msg}`);
      vscode.window.showInformationMessage(msg);
    }),

    vscode.commands.registerCommand('antigravity-trigger.triggerNow', () => {
      log('Manual poll triggered');
      pollOnce();
    })
  );

  // Start disabled — click status bar or run Enable command to activate
  log('Ready. Click status bar to enable.');
}

/**
 * Starts the polling timer.
 */
function startPolling() {
  stopPolling();

  if (!isEnabled) return;

  const { config, error } = loadTriggerConfig();
  if (error) {
    log(`Config error: ${error}`);
  }
  const intervalSeconds = config?.pollIntervalSeconds || 60;

  log(`Starting polling every ${intervalSeconds}s`);
  updateStatusBar('idle');

  // Initial poll after a short delay
  setTimeout(() => pollOnce(), 3000);

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
    log('Polling stopped');
  }
}

/**
 * Performs a single poll cycle.
 */
async function pollOnce() {
  if (!isEnabled) return;

  log('--- Poll cycle started ---');

  const { config, configPath, error: configError } = loadTriggerConfig();
  if (configError || !config) {
    lastPollStatus = configError || 'No config';
    lastPollTime = new Date();
    log(`Config: ${lastPollStatus}`);
    return;
  }

  if (!config.enabled) {
    lastPollStatus = 'Disabled in config';
    lastPollTime = new Date();
    log('Config has enabled=false, skipping');
    updateStatusBar('disabled');
    return;
  }

  const token = getGitHubToken();
  if (!token) {
    lastPollStatus = 'No GitHub token found in mcp_config.json';
    lastPollTime = new Date();
    log('ERROR: No GitHub token found');
    updateStatusBar('error');
    return;
  }

  // Filter triggers to only those matching this workspace's git remote
  const remote = getWorkspaceRemote();
  if (remote) {
    const remoteLabel = remote.platform === 'github'
      ? `${remote.owner}/${remote.repo}`
      : `codecommit:${remote.repo}`;
    log(`Workspace remote: ${remoteLabel} (${remote.platform})`);
    const before = config.triggers.length;
    config.triggers = config.triggers.filter(t => {
      const triggerPlatform = t.platform || 'github';
      let match = false;
      if (remote.platform === 'github' && triggerPlatform === 'github') {
        match = (t.owner || '').toLowerCase() === (remote.owner || '').toLowerCase() &&
                t.repo.toLowerCase() === remote.repo.toLowerCase();
      } else if (remote.platform === 'codecommit' && triggerPlatform === 'codecommit') {
        match = t.repo.toLowerCase() === remote.repo.toLowerCase();
      }
      if (!match) {
        log(`  Skipping trigger "${t.id}": platform/repo mismatch`);
      }
      return match;
    });
    if (config.triggers.length === 0 && before > 0) {
      lastPollStatus = 'No triggers match this workspace remote';
      log('No triggers match this workspace remote');
      updateStatusBar('idle');
      return;
    }
  } else {
    log('Could not detect workspace git remote, polling all triggers');
  }

  log(`Polling ${config.triggers.length} trigger(s)...`);
  updateStatusBar('polling');

  try {
    const state = extensionContext.globalState;

    // Split triggers by platform
    const githubTriggers = config.triggers.filter(t => !t.platform || t.platform === 'github');
    const ccTriggers = config.triggers.filter(t => t.platform === 'codecommit');

    // Poll GitHub triggers (needs token)
    const githubConfig = { ...config, triggers: githubTriggers };
    const githubTasks = githubTriggers.length > 0
      ? await pollAllTriggers(githubConfig, token, state)
      : [];

    // Poll CodeCommit triggers (uses SSH, no token needed)
    const ccTasks = ccTriggers.length > 0
      ? await pollAllCodeCommitTriggers(ccTriggers, state)
      : [];

    const triggeredTasks = [...githubTasks, ...ccTasks];

    lastPollTime = new Date();

    if (triggeredTasks.length === 0) {
      lastPollStatus = 'No new tagged changes detected';
      log('No new tagged changes detected');
      updateStatusBar('idle');
      return;
    }

    // Process triggered tasks (one at a time to avoid chat conflicts)
    for (const task of triggeredTasks) {
      // DEDUPLICATION: Re-read config fresh (agent may have updated taskLog)
      const freshConfig = loadTriggerConfig();
      const freshLog = freshConfig.config?.taskLog || config.taskLog || [];
      const alreadyProcessed = freshLog.some(
        entry => entry.triggerCommitSha.startsWith(task.commitSha.substring(0, 7)) ||
                 task.commitSha.startsWith(entry.triggerCommitSha.substring(0, 7))
      );
      if (alreadyProcessed) {
        log(`Skipping ${task.triggerId}: commit ${task.commitSha.substring(0, 7)} already in taskLog`);
        // Advance SHA so we don't rediscover this commit next cycle
        const stateKey = `lastSha_${task.triggerId}`;
        await state.update(stateKey, task.commitSha);
        continue;
      }

      // Check cooldown
      const cooldownMinutes = config.cooldownMinutes || 10;
      const cooldownKey = `cooldown_${task.triggerId}`;
      const lastTriggerTime = state.get(cooldownKey);

      if (lastTriggerTime) {
        const elapsed = Date.now() - lastTriggerTime;
        if (elapsed < cooldownMinutes * 60 * 1000) {
          const remaining = Math.round((cooldownMinutes * 60 * 1000 - elapsed) / 1000);
          log(`Skipping ${task.triggerId}: cooldown active (${remaining}s remaining)`);
          continue;
        }
      }

      // Pull latest changes before starting work (Aider or other agents may have pushed)
      await gitPullWorkspace(log);

      // Build and send prompt
      const prompt = buildPrompt(task);
      log(`TRIGGERING task: ${task.triggerId}`);
      log(`  Commit: ${task.commitMessage}`);
      log(`  Files: ${task.matchedFiles.join(', ')}`);
      updateStatusBar('triggered');

      const sent = await sendToChat(prompt, log);

      if (sent) {
        log(`Task sent to chat successfully!`);

        // Update cooldown
        await state.update(cooldownKey, Date.now());

        // Re-read config FRESH before modifying to avoid overwriting agent updates
        const latestConfig = loadTriggerConfig();
        const cfgToSave = latestConfig.config || config;

        // Add triggered entry to task log
        if (!cfgToSave.taskLog) cfgToSave.taskLog = [];
        cfgToSave.taskLog.push({
          triggerId: task.triggerId,
          status: 'triggered',
          triggerCommitSha: task.commitSha,
          resultCommitSha: null,
          triggeredAt: new Date().toISOString(),
          completedAt: null
        });

        // Update lastProcessedCommitSha on the trigger
        const trigger = cfgToSave.triggers.find(t => t.id === task.triggerId);
        if (trigger) {
          trigger.lastProcessedCommitSha = task.commitSha;
        }

        saveTriggerConfig(configPath, cfgToSave);

        // Send "in progress" Telegram notification
        const notifyConfig = cfgToSave.notifications?.telegram;
        if (notifyConfig?.enabled && notifyConfig?.botToken && notifyConfig?.chatId) {
          const taskTitle = task.commitMessage.replace(/^\[ag\]\s*task:\s*/i, '').trim();
          sendTelegramNotification(
            notifyConfig.botToken,
            notifyConfig.chatId,
            `🔄 Task in progress: ${taskTitle}`,
            log
          );
        }

        lastPollStatus = `Triggered: ${task.triggerId} (${task.matchedFiles.length} files)`;

        vscode.window.showInformationMessage(
          `🤖 Antigravity task triggered: ${task.triggerId}\n` +
          `Files: ${task.matchedFiles.join(', ')}`
        );
      } else {
        lastPollStatus = `Failed to send task: ${task.triggerId}`;
        log(`ERROR: Failed to send task to chat`);
        updateStatusBar('error');
      }
    }

    updateStatusBar('idle');
  } catch (err) {
    lastPollStatus = `Error: ${err.message}`;
    lastPollTime = new Date();
    log(`POLL ERROR: ${err.message}`);
    log(err.stack || '');
    updateStatusBar('error');
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
      statusBarItem.tooltip = 'Antigravity GitHub Trigger: Watching... (click to toggle)';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = '#89d185'; // light green when active
      break;
    case 'polling':
      statusBarItem.text = '$(sync~spin) AG Trigger';
      statusBarItem.tooltip = 'Polling GitHub...';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = '#89d185';
      break;
    case 'triggered':
      statusBarItem.text = '$(rocket) AG Triggered!';
      statusBarItem.tooltip = 'Task sent to Antigravity';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.color = undefined;
      break;
    case 'disabled':
      statusBarItem.text = '$(circle-slash) AG Trigger Off';
      statusBarItem.tooltip = 'Click to enable Antigravity GitHub Trigger';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = undefined;
      break;
    case 'error':
      statusBarItem.text = '$(error) AG Trigger';
      statusBarItem.tooltip = `Error: ${lastPollStatus}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      statusBarItem.color = undefined;
      break;
  }
}

/**
 * Extension deactivation.
 */
function deactivate() {
  stopPolling();
  if (outputChannel) {
    log('Extension deactivated');
  }
}

/**
 * Send a notification via Telegram Bot API.
 * @param {string} botToken
 * @param {string} chatId
 * @param {string} message
 * @param {Function} log
 */
function sendTelegramNotification(botToken, chatId, message, log) {
  const postData = JSON.stringify({ chat_id: chatId, text: message });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        log(`Telegram notification sent: ${message}`);
      } else {
        log(`Telegram notification failed (${res.statusCode}): ${body}`);
      }
    });
  });

  req.on('error', (err) => {
    log(`Telegram notification error: ${err.message}`);
  });

  req.write(postData);
  req.end();
}

module.exports = { activate, deactivate };
