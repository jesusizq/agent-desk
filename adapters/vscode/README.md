# VS Code extension

Handles `vscode://agent-desk.agent-desk/focus?session=<id>`, the link behind "Go to session": it
looks the session up in the store and shows the integrated terminal whose shell process is an
ancestor of the session's process. It never types into a terminal, runs commands, opens files or
makes network calls.

The link goes through the browser to VS Code, which brings its own window to the front. That is
what makes it work on GNOME under Wayland, where one program cannot raise another's window.

## Install

```sh
npm run package:vscode
code --install-extension dist/agent-desk-vscode-0.1.0.vsix
```

`package:vscode` compiles `src/extension.ts` with the shared core it imports and packs a `.vsix`
without extra tools. The first click on a session link makes the browser ask whether to open
VS Code; allowing it always avoids the question afterwards.

## Limits

- VS Code hands the link to one window (not verified which one when several are open). A session
  whose terminal is in another window is reported as not found, with a warning.
- The session's process ancestry is recorded by its adapter from `/proc`, so this works on Linux only.
