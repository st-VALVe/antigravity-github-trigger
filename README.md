# Antigravity GitHub Trigger

VS Code extension that automatically triggers Antigravity tasks when files change in GitHub repositories.

## Full Automation Cycle

```
GitHub push → Extension detects change → Sends task to Antigravity chat
→ Antigravity executes → Commits & pushes result → Marks task completed
```

## Setup

1. Install the extension (`.vsix` file)
2. Create `.antigravity-triggers.json` in any workspace root
3. Configure triggers for your repos
4. Ensure GitHub token is configured in `~/.gemini/antigravity/mcp_config.json`

## Configuration

Create `.antigravity-triggers.json` in workspace root:

```json
{
  "enabled": true,
  "pollIntervalSeconds": 60,
  "cooldownMinutes": 10,
  "triggers": [
    {
      "id": "my-trigger-name",
      "owner": "github-username",
      "repo": "repo-name",
      "branch": "main",
      "watchFiles": ["src/config/**", "docs/*.md"],
      "prompt": "Review changes to {{files}} in {{repo}} and update tests.",
      "autoPush": true,
      "lastProcessedCommitSha": null
    }
  ],
  "taskLog": []
}
```

### Trigger Fields

| Field | Description |
|-------|-------------|
| `id` | Unique trigger identifier |
| `owner` | GitHub repo owner |
| `repo` | Repository name |
| `branch` | Branch to watch |
| `watchFiles` | Glob patterns for files to watch |
| `prompt` | Task prompt template |
| `autoPush` | Auto-push changes after task (default: true) |
| `lastProcessedCommitSha` | Auto-updated, tracks last processed commit |

### Template Variables

`{{repo}}`, `{{owner}}`, `{{branch}}`, `{{files}}`, `{{commitMessage}}`, `{{commitUrl}}`, `{{author}}`

## Commands

- **Antigravity Trigger: Enable** — Start watching
- **Antigravity Trigger: Disable** — Stop watching
- **Antigravity Trigger: Show Status** — Current state and last poll result
- **Antigravity Trigger: Check Now** — Force immediate poll

## Status Bar

The extension shows status in the bottom-right:
- `$(eye) AG Trigger` — Watching
- `$(sync~spin) AG Trigger` — Polling
- `$(rocket) AG Triggered!` — Task sent
- `$(circle-slash) AG Trigger Off` — Disabled
- `$(error) AG Trigger` — Error occurred
