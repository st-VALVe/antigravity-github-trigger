const vscode = require('vscode');
const WebSocket = require('ws');
const { loadDispatchConfig, getWorkspacePath } = require('./config');
const { buildDispatchPrompt, sendToChat } = require('./chat-sender');

/** @type {WebSocket|null} */
let wsConnection = null;

/** @type {NodeJS.Timeout|null} */
let reconnectTimer = null;

/** @type {boolean} */
let isEnabled = false;

/** @type {string} */
let connectionStatus = 'disconnected';

/** @type {vscode.ExtensionContext} */
let extensionContext;

/** @type {vscode.StatusBarItem} */
let statusBarItem;

/** @type {vscode.OutputChannel} */
let outputChannel;

/**
 * Logs a message to the Output Channel.
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

  outputChannel = vscode.window.createOutputChannel('Antigravity Dispatch');
  context.subscriptions.push(outputChannel);
  log('Extension activated');

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity-dispatch.toggle';
  updateStatusBar('disconnected');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register status reporting commands (used by agent after task execution)
  registerStatusCommands(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-dispatch.toggle', () => {
      if (isEnabled) {
        isEnabled = false;
        disconnect();
        log('Disabled by user');
        vscode.window.showInformationMessage('Antigravity Dispatch: Disconnected');
      } else {
        isEnabled = true;
        log('Enabled by user');
        connect();
        vscode.window.showInformationMessage('Antigravity Dispatch: Connecting...');
      }
    }),

    vscode.commands.registerCommand('antigravity-dispatch.enable', () => {
      isEnabled = true;
      connect();
      log('Enabled via command');
      vscode.window.showInformationMessage('Antigravity Dispatch: Connecting...');
    }),

    vscode.commands.registerCommand('antigravity-dispatch.disable', () => {
      isEnabled = false;
      disconnect();
      log('Disabled via command');
      vscode.window.showInformationMessage('Antigravity Dispatch: Disconnected');
    }),

    vscode.commands.registerCommand('antigravity-dispatch.status', () => {
      const msg = `Status: ${isEnabled ? 'Enabled' : 'Disabled'} | Connection: ${connectionStatus}`;
      log(`Status check: ${msg}`);
      vscode.window.showInformationMessage(msg);
    })
  );

  log('Ready. Click status bar to enable.');
}

// ─── WebSocket Connection ─────────────────────────────────────

/** Current reconnect delay (exponential backoff) */
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 60000;

/**
 * Connect to the Dispatch Service via WebSocket.
 */
function connect() {
  if (!isEnabled) return;

  const { config, error } = loadDispatchConfig();
  if (error || !config) {
    log(`Config error: ${error || 'No config found'}`);
    updateStatusBar('error');
    return;
  }

  if (!config.enabled) {
    log('Config has enabled=false, skipping connection');
    updateStatusBar('disconnected');
    return;
  }

  if (!config.dispatchServer || !config.authToken) {
    log('ERROR: dispatchServer and authToken are required in config');
    updateStatusBar('error');
    return;
  }

  // Build WebSocket URL
  const wsUrl = `${config.dispatchServer}/ws?token=${encodeURIComponent(config.authToken)}`;
  log(`Connecting to ${config.dispatchServer}...`);
  updateStatusBar('connecting');

  try {
    wsConnection = new WebSocket(wsUrl, {
      // Accept self-signed certs in dev
      rejectUnauthorized: config.rejectUnauthorized !== false,
    });
  } catch (err) {
    log(`Connection failed: ${err.message}`);
    updateStatusBar('error');
    scheduleReconnect();
    return;
  }

  wsConnection.on('open', () => {
    log('Connected to Dispatch Service');
    connectionStatus = 'connected';
    reconnectDelay = 1000; // Reset backoff on success
    updateStatusBar('connected');
  });

  wsConnection.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleServerMessage(msg, config);
    } catch (err) {
      log(`Invalid message from server: ${err.message}`);
    }
  });

  wsConnection.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'unknown';
    log(`Connection closed: ${code} ${reasonStr}`);
    connectionStatus = 'disconnected';
    wsConnection = null;
    updateStatusBar('disconnected');

    if (isEnabled && code !== 4001) {
      // 4001 = invalid token, don't retry
      scheduleReconnect();
    } else if (code === 4001) {
      log('ERROR: Invalid auth token. Check .antigravity-dispatch.json');
      updateStatusBar('error');
    }
  });

  wsConnection.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
    // 'close' event will fire after this
  });

  // Respond to server pings (keep-alive through nginx)
  wsConnection.on('ping', () => {
    wsConnection?.pong();
  });
}

/**
 * Disconnect from the Dispatch Service.
 */
function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (wsConnection) {
    wsConnection.close(1000, 'Client disconnect');
    wsConnection = null;
  }

  connectionStatus = 'disconnected';
  updateStatusBar('disconnected');
}

/**
 * Schedule a reconnection with exponential backoff.
 */
function scheduleReconnect() {
  if (!isEnabled) return;
  if (reconnectTimer) return;

  log(`Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

// ─── Task Handling ────────────────────────────────────────────

/**
 * Handle incoming message from the Dispatch Service.
 * @param {object} msg
 * @param {object} config
 */
async function handleServerMessage(msg, config) {
  if (msg.type === 'new_task') {
    log(`RECEIVED TASK: ${msg.id} — "${msg.title}"`);
    updateStatusBar('triggered');

    // Send "in progress" status back
    sendStatus(msg.id, 'in_progress');

    // Run git pull before starting task
    await gitPullWorkspace();

    // Build prompt and send to agent panel
    const prompt = buildDispatchPrompt(msg, config);
    const sent = await sendToChat(prompt, log);

    if (sent) {
      log(`Task ${msg.id} sent to agent panel`);
      vscode.window.showInformationMessage(
        `📡 Dispatch task received: ${msg.title}`
      );
    } else {
      log(`ERROR: Failed to send task ${msg.id} to agent panel`);
      sendStatus(msg.id, 'failed', 'Failed to deliver to agent panel');
      updateStatusBar('error');
    }

    // After a short delay, return to connected status
    setTimeout(() => {
      if (connectionStatus !== 'error') {
        updateStatusBar('connected');
      }
    }, 5000);
  }
}

/**
 * Send a task status update back to the Dispatch Service.
 * @param {string} taskId
 * @param {string} status — 'in_progress' | 'completed' | 'failed'
 * @param {string} [summary]
 */
function sendStatus(taskId, status, summary) {
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
    log(`Cannot send status (not connected): task ${taskId} → ${status}`);
    return;
  }

  const msg = { type: 'task_status', id: taskId, status };
  if (summary) msg.summary = summary;

  wsConnection.send(JSON.stringify(msg));
  log(`Status sent: task ${taskId} → ${status}`);
}

// Make sendStatus available as a VS Code command so the agent can call it
// after completing work (e.g., from a terminal or chat action)
// Usage: vscode.commands.executeCommand('antigravity-dispatch.completeTask', taskId, summary)

/**
 * Register the completeTask and failTask commands.
 * These allow the Antigravity agent to report status back after execution.
 */
function registerStatusCommands(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-dispatch.completeTask', (taskId, summary) => {
      sendStatus(taskId, 'completed', summary || 'Task completed');
      log(`Task ${taskId} marked completed by agent`);
    }),

    vscode.commands.registerCommand('antigravity-dispatch.failTask', (taskId, summary) => {
      sendStatus(taskId, 'failed', summary || 'Task failed');
      log(`Task ${taskId} marked failed by agent`);
    })
  );
}

// ─── Git Pull ─────────────────────────────────────────────────

const { execFile } = require('child_process');

/**
 * Runs `git pull --rebase` in the workspace.
 * @returns {Promise<void>}
 */
function gitPullWorkspace() {
  const wsPath = getWorkspacePath();
  if (!wsPath) {
    log('git pull: no workspace folder found, skipping');
    return Promise.resolve();
  }

  log(`git pull --rebase in ${wsPath}`);

  return new Promise((resolve) => {
    execFile('git', ['pull', '--rebase'], { cwd: wsPath, timeout: 30000 }, (err, stdout) => {
      if (err) {
        log(`git pull warning: ${err.message}`);
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

// ─── Status Bar ───────────────────────────────────────────────

/**
 * Updates the status bar item.
 * @param {'connected'|'connecting'|'disconnected'|'triggered'|'error'} state
 */
function updateStatusBar(state) {
  connectionStatus = state;

  switch (state) {
    case 'connected':
      statusBarItem.text = '$(radio-tower) AG Dispatch';
      statusBarItem.tooltip = 'Antigravity Dispatch: Connected (click to toggle)';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = '#89d185';
      break;
    case 'connecting':
      statusBarItem.text = '$(sync~spin) AG Dispatch';
      statusBarItem.tooltip = 'Connecting to Dispatch Service...';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = '#dcdcaa';
      break;
    case 'disconnected':
      statusBarItem.text = '$(circle-slash) AG Dispatch Off';
      statusBarItem.tooltip = 'Click to connect to Dispatch Service';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = undefined;
      break;
    case 'triggered':
      statusBarItem.text = '$(rocket) AG Task!';
      statusBarItem.tooltip = 'Task received from Dispatch Service';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.color = undefined;
      break;
    case 'error':
      statusBarItem.text = '$(error) AG Dispatch';
      statusBarItem.tooltip = 'Dispatch connection error — check Output panel';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      statusBarItem.color = undefined;
      break;
  }
}

// ─── Lifecycle ────────────────────────────────────────────────

function deactivate() {
  disconnect();
  if (outputChannel) {
    log('Extension deactivated');
  }
}

module.exports = { activate, deactivate };
