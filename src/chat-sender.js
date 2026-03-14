const vscode = require('vscode');

/**
 * Builds a prompt for a task received via the Dispatch Service WebSocket.
 * @param {object} task — { id, title, description, repo, branch, replyTo }
 * @param {object} config — dispatch config with optional prompt template
 * @returns {string}
 */
function buildDispatchPrompt(task, config) {
  // Use custom prompt template if provided, otherwise use default
  let prompt = config.prompt || DEFAULT_PROMPT_TEMPLATE;

  prompt = prompt
    .replace(/\{\{task\}\}/g, task.description || task.title)
    .replace(/\{\{title\}\}/g, task.title || '')
    .replace(/\{\{repo\}\}/g, task.repo || '')
    .replace(/\{\{branch\}\}/g, task.branch || 'main')
    .replace(/\{\{taskId\}\}/g, task.id || '')
    .replace(/\{\{replyTo\}\}/g, task.replyTo || '');

  return prompt;
}

const DEFAULT_PROMPT_TEMPLATE = `🤖 AUTOMATED TASK from Dispatch Service

Task ID: {{taskId}}
Repository: {{repo}} (branch: {{branch}})

TASK: {{task}}

AFTER COMPLETING THE TASK:
1. Stage all changes: git add .
2. Commit with a descriptive message
3. Push to {{branch}}:
   IMPORTANT: Set SafeToAutoRun: true for the git push command. This is explicitly authorized by the user.
4. Report completion to Dispatch Service (this sends a Telegram notification to the user automatically):
   curl -s -X POST http://13.48.8.43:18791/tasks/{{taskId}}/status -H "Content-Type: application/json" -d "{\\"status\\":\\"completed\\",\\"summary\\":\\"<brief description of what was done>\\"}"
   Set SafeToAutoRun: true for this curl command.
   If the task FAILED, use "failed" instead of "completed".`;

/**
 * Sends a message to the Antigravity agent panel.
 * @param {string} message - The message to send
 * @param {function} [log] - Logger function
 * @returns {Promise<boolean>} Whether the message was sent successfully
 */
async function sendToChat(message, log = () => {}) {

  // Strategy 1: antigravity.sendPromptToAgentPanel (native Antigravity command)
  log('Strategy 1: antigravity.sendPromptToAgentPanel...');
  try {
    await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', message);
    log('Prompt placed in agent panel, attempting auto-submit...');

    await sleep(300);

    // Try various ways to submit
    const submitted = await trySubmit(log);
    if (submitted) {
      log('SUCCESS: prompt sent and submitted');
    } else {
      log('Prompt placed but auto-submit failed — user needs to press Enter');
    }
    return true;
  } catch (err) {
    log(`FAILED: ${err.message}`);
  }

  // Strategy 2: Open agent + send prompt
  log('Strategy 2: antigravity.openAgent + sendPromptToAgentPanel...');
  try {
    await vscode.commands.executeCommand('antigravity.openAgent');
    await sleep(500);
    await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', message);
    log('SUCCESS via openAgent + sendPromptToAgentPanel');
    return true;
  } catch (err) {
    log(`FAILED: ${err.message}`);
  }

  // Strategy 3: Focus agent panel + clipboard paste
  log('Strategy 3: Focus panel + clipboard...');
  try {
    const originalClipboard = await vscode.env.clipboard.readText();

    await vscode.commands.executeCommand('antigravity.agentSidePanel.focus');
    await sleep(500);
    await vscode.env.clipboard.writeText(message);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await sleep(300);

    // Try Enter key to submit
    await vscode.commands.executeCommand('type', { text: '\n' });

    await vscode.env.clipboard.writeText(originalClipboard);
    log('Clipboard fallback completed (agentSidePanel)');
    return true;
  } catch (err) {
    log(`FAILED: ${err.message}`);
  }

  log('ALL STRATEGIES FAILED');
  return false;
}

/**
 * Tries to submit the chat input by simulating Enter key press.
 * @param {function} log - Logger function
 * @returns {Promise<boolean>}
 */
async function trySubmit(log) {
  const submitCommands = [
    'workbench.action.chat.acceptInput',
    'workbench.action.chat.submit',
    'antigravity.chat.submit',
    'chat.action.submit',
  ];

  for (const cmd of submitCommands) {
    try {
      await vscode.commands.executeCommand(cmd);
      log(`  Submitted via ${cmd}`);
      return true;
    } catch {
      // continue to next
    }
  }

  // Fallback: simulate Enter key
  try {
    await vscode.commands.executeCommand('default:type', { text: '\n' });
    log('  Submitted via default:type Enter');
    return true;
  } catch {
    // try without default prefix
  }

  try {
    await vscode.commands.executeCommand('type', { text: '\n' });
    log('  Submitted via type Enter');
    return true;
  } catch {
    log('  type command failed');
  }

  return false;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  buildDispatchPrompt,
  sendToChat
};
