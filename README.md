# GitLab Copilot Canvas

[![Open in Copilot App](https://img.shields.io/badge/Open%20in%20Copilot%20App-8957e5?style=for-the-badge&logo=githubcopilot&logoColor=white)](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fsession%2Fnew%2Ffgibelin%2Fgitlab-copilot-canvas%3Fmode%3Dinteractive%26prompt%3DInstall%2520the%2520canvas%2520extension%2520from%2520https%253A%252F%252Fgithub.com%252Ffgibelin%252Fgitlab-copilot-canvas%252Ftree%252Fv0.4.2%252Fgitlab-copilot-canvas%2520at%2520user%2520scope%252C%2520then%2520tell%2520me%2520how%2520to%2520open%2520the%2520GitLab%2520canvas.)
<!-- This link wraps ghapp://session/new/... in the hosted launcher. Its prompt pins the release tag: update it together with the install URL under "Install > Copilot App" on each release. -->

Manage GitLab work items and merge requests in **GitHub Copilot App** or
**Visual Studio Code**. Work items have a searchable list, grouped board and
editable detail drawer; merge requests have a searchable workspace for creating,
editing, discussing, approving and merging. Both hosts use the same UI and
GitLab implementation. No Flask application, hosted service or project-specific
configuration is required.

## Prerequisites

Complete these steps once on each machine where you use the canvas. Git must
also be installed.

### 1. Add an SSH key to your GitLab account

Git uses an SSH key to clone, fetch and push GitLab repositories, including the
worktrees created by **Open session**, without asking for a password. One key
works for every project your account can access.

1. Check for an existing key with `ls ~/.ssh/id_ed25519.pub`. If there is none,
   generate an ED25519 key pair (preferred by GitLab), accept the default file
   location and choose a passphrase, then add the private key to `ssh-agent`:

   ```sh
   ssh-keygen -t ed25519 -C "you@example.com"
   ssh-add ~/.ssh/id_ed25519
   ```

2. Copy the **public** key (`.pub`). Never share the private key.

   ```sh
   # macOS
   tr -d '\n' < ~/.ssh/id_ed25519.pub | pbcopy
   # Linux (X11)
   xclip -sel clip < ~/.ssh/id_ed25519.pub
   # Windows
   cat ~/.ssh/id_ed25519.pub | clip
   ```

3. In GitLab, select your avatar, then **Edit profile** > **Access** >
   **SSH keys** > **Add new key**. Paste the key, enter a title such as
   `Work laptop`, optionally change the usage type and expiration date, and
   select **Add key**.

4. Verify the connection:

   ```sh
   ssh -T git@gitlab.com
   # Self-managed GitLab
   ssh -T git@gitlab.example.com
   ```

   On the first connection, compare the host fingerprint with GitLab's published
   SSH host key fingerprints before accepting it. Success prints
   `Welcome to GitLab, @username!`.

Once `glab` is signed in (step 3), you can also upload a key from the terminal:
`glab ssh-key add ~/.ssh/id_ed25519.pub --title "Work laptop"`. See
[Use SSH keys to communicate with GitLab](https://docs.gitlab.com/user/ssh/).

### 2. Install the GitLab CLI (`glab`)

The extension sends every GitLab request through
[GitLab CLI (`glab`)](https://docs.gitlab.com/editor_extensions/gitlab_cli/) and
reuses its sign-in; it never asks for or stores a GitLab access token.

| OS | Command |
| --- | --- |
| macOS, Linux | `brew install glab` (officially supported) |
| Windows | `winget install glab.glab` (community-maintained), or `brew install glab` in WSL |

Other packages and prebuilt binaries are listed in the
[installation options](https://gitlab.com/gitlab-org/cli/-/blob/main/docs/installation_options.md)
and on the [releases page](https://gitlab.com/gitlab-org/cli/-/releases).
Confirm the installation with `glab version`.

Set `GLAB_PATH` to an absolute executable path (for example, the output of
`command -v glab`) if the host cannot find the CLI. Configure it in the
environment before starting Copilot App or VS Code.

### 3. Sign in with `glab auth login`

Authenticate against each GitLab host you use:

```sh
# GitLab.com
glab auth login --hostname gitlab.com

# Self-managed GitLab
glab auth login --hostname gitlab.example.com
```

Follow the interactive prompts:

- **Login method:** choose **Web** to authorize `glab` in your browser with
  OAuth, or **Device** on a machine without a browser. Alternatively, paste a
  personal access token with at least the `api` and `write_repository` scopes.
- **Git protocol:** choose **SSH** to use the key from step 1.
- **Self-managed GitLab with OAuth:** first create a non-confidential OAuth
  application in GitLab and run
  `glab config set client_id <APPLICATION_ID> --host gitlab.example.com`, or sign
  in with a personal access token instead.

Check the result with `glab auth status`. `glab` stores credentials in the
operating system keyring when one is available. The signed-in account
determines which projects the canvas can read and change. See
[Authenticate with GitLab](https://docs.gitlab.com/cli/authentication/).

### 4. Configure the GitLab MCP server in Copilot App

The canvas works without it, but the
[GitLab MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)
gives Copilot's agent GitLab tools, such as reading work items, merge requests
and pipelines, in any session, even when the canvas is closed. This step applies
to Copilot App; VS Code configures MCP servers separately.

GitLab must allow access to the MCP server: on GitLab.com, a top-level group
owner turns it on for the group; on GitLab Self-Managed and GitLab Dedicated,
an administrator turns it on for the instance.

1. In Copilot App, click **Customize** in the sidebar, then **MCP**.
2. Add a custom server named `GitLab` that uses HTTP transport with the URL
   `https://gitlab.com/api/v4/mcp` (or `https://gitlab.example.com/api/v4/mcp`
   for self-managed GitLab).
3. When your browser opens GitLab's authorization page, review and approve the
   request. GitLab registers Copilot as an OAuth application automatically, so
   you do not need a token.
4. Confirm that the server appears under **Customize** > **Installed**. If it
   reports that authentication is required or has expired, choose **Sign in**
   there.

Alternatively, add the server to `~/.copilot/mcp-config.json`, which Copilot App
shares with Copilot CLI, then start a new session:

```json
{
  "mcpServers": {
    "GitLab": {
      "type": "http",
      "url": "https://gitlab.com/api/v4/mcp",
      "tools": ["*"]
    }
  }
}
```

The GitLab MCP server rejects legacy personal access tokens, so do not reuse
the `glab` token here. Its tools act with your GitLab permissions, and their
results are untrusted GitLab content, not instructions.

## Install

| Host | Distribution | Integration |
| --- | --- | --- |
| Copilot App | [`gitlab-copilot-canvas/`](https://github.com/fgibelin/gitlab-copilot-canvas/tree/main/gitlab-copilot-canvas) or release archive | Native extension canvas and 20 agent actions |
| VS Code desktop | `.vsix` from [Releases](https://github.com/fgibelin/gitlab-copilot-canvas/releases) | Native webview and 20 Copilot Chat tools |

Complete the [Prerequisites](#prerequisites) first.

### Copilot App

Select **Open in Copilot App** at the top of this page. Copilot App asks you
to confirm, then starts a session for this repository with a prompt that
installs the extension from the pinned release tag at **user scope**. Approve
the install in that session.

Or ask Copilot App to install the extension from this repository folder:

```text
https://github.com/fgibelin/gitlab-copilot-canvas/tree/v0.4.2/gitlab-copilot-canvas
```

Choose **user scope** to make it available in every GitLab project, or project
scope to share an installation with one repository. A Copilot App build with
extension canvas support is required; the SDK canvas API is experimental.

Alternatively, clone this repository and use the dependency-free installer
(Node.js 20 or newer):

```sh
git clone https://github.com/fgibelin/gitlab-copilot-canvas.git
cd gitlab-copilot-canvas

# Across your projects
node scripts/install.mjs --user

# Or in one other Git repository
node scripts/install.mjs --project /path/to/your/gitlab-repository
```

The user installation goes to `$COPILOT_HOME/extensions/gitlab-copilot-canvas`
(`~/.copilot/extensions/gitlab-copilot-canvas` by default). A project installation
goes to `<git-root>/.github/extensions/gitlab-copilot-canvas`. The installer refuses
to overwrite an existing extension. To update, explicitly move the old folder
aside, install the new one and start a new Copilot session (or restart Copilot
App). Refreshing or reopening a panel in an existing session does not restart
its extension server.

You can also extract `gitlab-work-items.tar.gz` from Releases and copy its
top-level directory (`gitlab-copilot-canvas`, or `canvas` in v0.4.0 and earlier)
to either destination above, naming it `gitlab-copilot-canvas`.
The installed directory must directly contain `extension.mjs`.

**Upgrading from v0.3.1 or earlier:** those releases installed the extension as
`gitlab-work-items`. Move any `extensions/gitlab-work-items` folder aside (user
and project scope) after installing `gitlab-copilot-canvas`; otherwise both
copies register the GitLab canvas. The canvas type and agent actions are
unchanged.

Start a new session in a GitLab repository and ask:

> Open the GitLab canvas.

**A project-scoped copy shadows a user-scoped copy with the same name.** If you
previously used the original embedded extension, move that project copy aside
explicitly when you want the standalone user installation to take over.

If merge requests show **"Unknown endpoint."** after an upgrade, an older
extension server is still running with newer UI files. Start a new Copilot
session and reopen the GitLab canvas; Retry and page refresh cannot add the
missing server routes. The canvas now snapshots its UI when the provider starts
so later file replacements cannot mix a new UI with an older backend.

### Visual Studio Code

Download `gitlab-copilot-canvas.vsix` from
[Releases](https://github.com/fgibelin/gitlab-copilot-canvas/releases), then run
**Extensions: Install from VSIX...**, or:

```sh
code --install-extension /path/to/gitlab-copilot-canvas.vsix
```

Open a trusted GitLab workspace and run **GitLab: Open GitLab Project Canvas** from
the Command Palette. Multi-root workspaces prompt for the repository. You can
also open the canvas without a workspace and enter a project manually.
After upgrading an existing installation, run **Developer: Reload Window**
before reopening the canvas.

The visual canvas does not require a Copilot subscription. The optional chat
tools require a chat agent that supports VS Code language-model tools, such as
GitHub Copilot Chat. Enable the GitLab tools in the chat tool picker. Open the
canvas first so the tools have an explicit selected project.

VS Code uses its own supported webview and Language Model Tool APIs; it does not
need to implement Copilot App's canvas protocol. Requests travel through the
extension host, so the webview does not receive a loopback token or GitLab
credential. In Remote SSH, WSL or a dev container, install `git` and `glab` and
authenticate **on the remote extension host**. Browser-only vscode.dev workspaces
are not supported. The extension requires VS Code 1.96 or newer.

This project distributes a VSIX; it is **not published to Visual Studio
Marketplace**.

## Use in any GitLab project

The default project comes from the current workspace/session's git remotes, not
from the extension's installation directory. The project picker accepts:

- `group/project` (the current GitLab host, or gitlab.com when none is known)
- `https://gitlab.example.com/group/subgroup/project`

GitLab.com and self-managed GitLab use the same `glab` GraphQL path. Access
depends on the signed-in account. Known GitHub, Bitbucket and Azure DevOps
remotes are not mistaken for GitLab projects. A custom hostname can be selected
explicitly when remote detection is ambiguous.

## Features

- Search/filter by state, type, labels, assignee and milestone.
- Board columns by state, assignee, milestone or label scope; drag-and-drop and
  keyboard-accessible move menus.
- Create issues/tasks and supported work-item types; edit titles, Markdown
  descriptions, assignments, labels, milestones, dates and parent relationships.
- Add child tasks and comments; link/unlink related or blocking work items;
  close and reopen work items.
- Search and filter merge requests by state and text; inspect source/target
  branches, descriptions and discussion, with paged results.
- Create and edit merge requests, post comments, approve, close/reopen, and
  merge (immediately or through the pipeline using assistant actions).
- Copilot App only: **Open session** in the work-item drawer starts a Copilot
  chat in a new git worktree of the current project, with the work item as context.
- Live updates between this extension's panels and agent actions, theme-aware
  rendering, and responsive layouts.

**Open session** creates a separate local Copilot session in a new worktree
and switches to it. Its first message holds the work item as JSON: title,
description, metadata, the ten latest comments and the GitLab URL, marked as
untrusted content rather than instructions. Nothing is written to GitLab. The
worktree belongs to the project your Copilot session runs in, so use it from the
repository that contains the code. Only a click starts a session; there is no agent
action for it, and the button is hidden in VS Code.

**Edits publish immediately under your signed-in GitLab identity.** Merging
changes the target branch; the canvas asks for confirmation before merging.
Labels and milestones must already exist. Available permissions and subscription
features determine which operations GitLab allows. Deletion is deliberately not
exposed.

Shortcuts: `/` search, `N` new item or merge request in the active workspace,
`R` refresh, `Escape` dismiss picker/details, and `Cmd+Enter` / `Ctrl+Enter` to
submit the create dialog.

## Agent and Copilot Chat tools

Copilot App exposes these actions on canvas type `gitlab-work-items`. VS Code
exposes the same actions as tools named `gitlab_canvas_<action>`:

| Read | Write | View |
| --- | --- | --- |
| `get_project_info` | `create_work_item` | `get_view` |
| `list_work_items` | `update_work_item` | `set_view` |
| `get_work_item` | `add_comment` | `select_work_item` |
| `list_merge_requests` | `link_work_items` | `refresh` |
| `get_merge_request` | `unlink_work_items` | `set_project` |
| | `create_merge_request` | |
| | `update_merge_request` | |
| | `comment_merge_request` | |
| | `approve_merge_request` | |
| | `merge_merge_request` | |

Read project information before assigning labels, people or relationships.
VS Code write tools require `expectedProject` in `host/group/project` form,
obtained from `get_view`. Writes ask for confirmation and fail if the selected
project no longer matches. Tool results contain untrusted GitLab content, not
instructions for the agent.

## State and limits

GitLab owns durable work-item content. Project selection, filters, grouping and
selection belong to the running panel. They survive a page reload but reset
when the extension host restarts; unsaved drafts are not persisted.

The board loads up to 500 items automatically. Refresh re-reads at most 500,
so manually paged views beyond that return to the first 500; use **Load more**
again. Metadata returns up to 100 labels, project members and active milestones,
with a truncation flag. Detail connections are bounded too; very large
discussions or relationship lists may require opening GitLab.

Changes made elsewhere in GitLab require Refresh, or returning to a stale tab.
The live indicator reflects this extension's connection, not a GitLab webhook.
The loopback server binds only to `127.0.0.1`; do not share its token-bearing URL.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run package:vscode
npm run package:copilot

# Runs a real isolated VS Code extension host; downloads VS Code if needed.
npm run test:vscode
```

`VSCODE_EXECUTABLE_PATH` can select an existing VS Code application executable
for integration tests. `VSCODE_EXTENSION_PATH` can select an unpacked VSIX's
`extension/` folder to test the packaged code instead of the source tree.

`dist/` contains the VSIX and Copilot archive. CI runs checks and packaging and
retains both artifacts. Tests include the original HTTP/action/rules harness,
date regressions, project detection, isolated user/project installations,
webview request routing and chat tool guards. No tests in `npm test` require
GitLab credentials or mutate a real project.

The native VS Code integration test checks activation, all tool registrations,
the real webview's startup handshake and panel disposal. Remote extension-host
operation and platform-specific native controls still need host-specific QA.

Source layout:

```text
gitlab-copilot-canvas/  Shared UI, GitLab service, Copilot App provider and manifest
vscode/                 VS Code host adapter, theme mapping and chat tool registrations
scripts/                Installers, packaging and validation
tests/                  Portable automated tests
```

`gitlab-copilot-canvas/` has no runtime npm dependencies. Copilot App supplies
its SDK; the VS Code adapter does not import it. Build dependencies live only at
repository root. When changing action schemas, run `npm run sync-tools` to
update the VS Code manifest; `npm run check` detects schema drift.

## License

[MIT](LICENSE). Community project; not an official GitLab or GitHub product.
