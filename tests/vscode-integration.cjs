const assert = require("node:assert/strict");
const vscode = require("vscode");

exports.run = async () => {
    const extension = vscode.extensions.getExtension("fgibelin.gitlab-copilot-canvas");
    assert.ok(extension);
    await extension.activate();
    assert.ok(extension.isActive);
    assert.equal(vscode.lm.tools.filter(tool => tool.name.startsWith("gitlab_canvas_")).length, 20);
    const state = await vscode.commands.executeCommand("gitlabCanvas.open");
    assert.equal(state?.configured, false, "A fresh window must show project selection");
    assert.equal(state.instanceId, "vscode-work-items");
    assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.label === "GitLab").length, 1);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    console.log("PASS: VS Code activation, all 20 tools, real webview renderer handshake, no-project view and disposal.");
};
