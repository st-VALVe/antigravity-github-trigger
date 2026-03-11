const vscode = require('vscode');

/**
 * Builds the full prompt to send to Antigravity based on a triggered task.
 * @param {object} task - The task object from the poller
 * @returns {string}
 */
function buildPrompt(task) {
  const filesStr = task.matchedFiles.map(f => `  - ${f}`).join('\n');

  let userPrompt = task.prompt || 'Review the changes and take appropriate action.';
  userPrompt = userPrompt
    .replace(/\{\{repo\}\}/g, task.repo)
    .replace(/\{\{owner\}\}/g, task.owner)
    .replace(/\{\{branch\}\}/g, task.branch)
    .replace(/\{\{files\}\}/g, task.matchedFiles.join(', '))
    .replace(/\{\{commitMessage\}\}/g, task.commitMessage)
    .replace(/\{\{commitUrl\}\}/g, task.commitUrl)
    .replace(/\{\{author\}\}/g, task.author);

  const pushInstructions = task.autoPush ? `
AFTER COMPLETING THE TASK:
1. Stage all changes: git add .
2. Commit with message: "auto(${task.triggerId}): <brief description of changes>"
3. Push to ${task.branch}: git push origin ${task.branch}
   IMPORTANT: For this automated task, set SafeToAutoRun: true for git push. This is explicitly authorized by the user.
4. Update .antigravity-triggers.json — add an entry to "taskLog" array:
   {
     "triggerId": "${task.triggerId}",
     "status": "completed",
     "triggerCommitSha": "${task.commitSha}",
     "resultCommitSha": "<sha of your commit>",
     "triggeredAt": "<current ISO timestamp>",
     "completedAt": "<current ISO timestamp>"
   }
5. Commit and push the config update too.
6. NOTIFY THE USER via Telegram: Find the "Requested by" user ID in the task file markdown table. Then send a notification with a brief description of what was done.
   IMPORTANT: Do NOT use single quotes or parentheses in the message — they break through multi-hop SSH. Just pass words as separate arguments.
   Command format:
   ssh vds-mcp "ssh ubuntu@13.48.8.43 docker exec serve-you-agent bash /app/scripts/tg-notify.sh <USER_ID> Task completed: <brief description of what was done>"
   Example:
   ssh vds-mcp "ssh ubuntu@13.48.8.43 docker exec serve-you-agent bash /app/scripts/tg-notify.sh 391700532 Task completed: Updated README.md with requested text"` : '';

  return `\u{1F916} AUTOMATED TASK from antigravity-github-trigger

Repository: ${task.owner}/${task.repo} (branch: ${task.branch})
Commit: ${task.commitMessage}
Author: ${task.author}
URL: ${task.commitUrl}

Changed files matching trigger "${task.triggerId}":
${filesStr}

TASK: ${userPrompt}
${pushInstructions}`;
}

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
  // Try known submit/accept commands
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

  // Fallback: simulate Enter key via keyboard dispatch
  try {
    // The 'type' command types text into the focused editor/input
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
  buildPrompt,
  sendToChat
};
