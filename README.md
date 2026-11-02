# GitLab Copilot Canvas

Manage GitLab work items and merge requests in **GitHub Copilot App** or
**Visual Studio Code**. Work items have a searchable list, grouped board and
editable detail drawer; merge requests have a searchable workspace for creating,
editing, discussing, approving and merging. Both hosts use the same UI and
GitLab implementation. No Flask application, hosted service or project-specific
configuration is required.

## Install

| Host | Distribution | Integration |
| --- | --- | --- |
| Copilot App | [`canvas/`](https://github.com/fgibelin/gitlab-copilot-canvas/tree/main/canvas) or release archive | Native extension canvas and 20 agent actions |
| VS Code desktop | `.vsix` from [Releases](https://github.com/fgibelin/gitlab-copilot-canvas/releases) | Native webview and 20 Copilot Chat tools |

### Prerequisites

Install [GitLab CLI (`glab`)](https://docs.gitlab.com/editor_extensions/gitlab_cli/)
and authenticate against the GitLab host you use:

```sh
# macOS
brew install glab
glab auth login --hostname gitlab.com

# Self-managed GitLab
glab auth login --hostname gitlab.example.com
```

Git must also be installed. The extension delegates authentication to `glab`;
it never asks for or stores a GitLab access token. Set `GLAB_PATH` to an absolute
executable path if the host cannot find the CLI. Configure it in the environment
before starting Copilot App or VS Code.

### Copilot App

Ask Copilot App to install the extension from this repository folder:

```text
https://github.com/fgibelin/gitlab-copilot-canvas/tree/v0.3.1/canvas
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
`canvas` directory to either destination above, naming it `gitlab-copilot-canvas`.
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
canvas/     Shared UI, GitLab service, Copilot App provider and manifest
vscode/     VS Code host adapter, theme mapping and chat tool registrations
scripts/    Installers, packaging and validation
tests/      Portable automated tests
```

`canvas/` has no runtime npm dependencies. Copilot App supplies its SDK; the
VS Code adapter does not import it. Build dependencies live only at repository
root. When changing action schemas, run `npm run sync-tools` to update the
VS Code manifest; `npm run check` detects schema drift.

## License

[MIT](LICENSE). Community project; not an official GitLab or GitHub product.
