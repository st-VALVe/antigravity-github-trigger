const vscode = require('vscode');

/**
 * Builds the full prompt to send to Antigravity based on a triggered task.
 * @param {object} task - The task object from the poller
 * @returns {string}
 */
function buildPrompt(task) {
  const filesStr = task.matchedFiles.map(f => `  - ${f}`).join('\n');

  // Replace template variables in user-defined prompt
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
5. Commit and push the config update too.` : '';

  return `🤖 AUTOMATED TASK from antigravity-github-trigger

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
 * Sends a message to the Antigravity chat panel.
 * Uses Antigravity-native command first, then falls back to VS Code standard commands.
 * @param {string} message - The message to send
 * @returns {Promise<boolean>} Whether the message was sent successfully
 */
async function sendToChat(message) {
  // Strategy 1: Antigravity-native command (most reliable)
  try {
    await vscode.commands.executeCommand('antigravity.sendTextToChat', message);
    console.log('[antigravity-trigger] Message sent via antigravity.sendTextToChat');
    return true;
  } catch (err) {
    console.warn(`[antigravity-trigger] antigravity.sendTextToChat failed: ${err.message}`);
  }

  // Strategy 2: Standard VS Code chat command with auto-submit
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: message,
      isPartialQuery: false
    });
    console.log('[antigravity-trigger] Message sent via workbench.action.chat.open');
    return true;
  } catch (err) {
    console.warn(`[antigravity-trigger] workbench.action.chat.open failed: ${err.message}`);
  }

  // Strategy 3: Clipboard-based fallback
  try {
    const originalClipboard = await vscode.env.clipboard.readText();

    // Try Antigravity-specific chat open
    try {
      await vscode.commands.executeCommand('antigravity.openChat');
    } catch {
      // Fallback to generic chat open
      await vscode.commands.executeCommand('workbench.action.chat.open');
    }

    await sleep(500);
    await vscode.env.clipboard.writeText(message);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await sleep(300);

    // Try multiple submit commands
    const submitCommands = [
      'antigravity.chat.submit',
      'workbench.action.chat.submit',
      'chat.action.submit'
    ];
    for (const cmd of submitCommands) {
      try {
        await vscode.commands.executeCommand(cmd);
        break;
      } catch { /* try next */ }
    }

    await vscode.env.clipboard.writeText(originalClipboard);
    console.log('[antigravity-trigger] Message sent via clipboard fallback');
    return true;
  } catch (err) {
    console.error(`[antigravity-trigger] All chat methods failed: ${err.message}`);
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
