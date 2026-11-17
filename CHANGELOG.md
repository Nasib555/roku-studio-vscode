# Changelog

## 2.0.0

- Packaging no longer ships OS/IDE junk that Roku static analysis rejects (`.idea/` with `file://` URLs, Finder/Explorer "copy" duplicates, `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, editor backups and swap files, `.git/`, `.vscode/`, and more). Matching is done in the extension, identically on macOS, Windows and Linux.
- New setting `rokuStudio.packageExclude` holds the exclude list (defaults cover the above). Every skipped path is listed in the Roku console.
- Warns about `file://` URLs found in `.brs`, `.xml`, `.json` and the manifest (file and line), and about `name (N).ext` files, which are kept because they may be real assets.
- Breaking: package contents change. Anything previously shipped that matches the exclude list is now left out.

## 1.1.1

- Fixed: deploys no longer uninstall the previous dev channel, so registry data (playlists, settings, theme) survives redeploys. Installs now use `mysubmit=Replace`.
- New opt-in setting `rokuStudio.wipeDataOnDeploy` (default off) for the old uninstall-then-install behaviour. Uninstalling erases the registry.
- The manifest bump is now applied only inside the generated package; the manifest on disk is no longer modified.
- Install results are read from the device's JSON messages; HTTP 401/403, "Identical", "Install Failure" and compile failures are reported with the device's text. Credentials no longer appear in the curl command line.

## 1.0.0

First public release.

- Find Roku devices on the network with SSDP, or enter an IP by hand
- Sideload the channel in one click, with the developer password kept in the OS keychain
- BrightScript compile errors and runtime crashes reported in the Problems panel
- Debug console (port 8085) streamed into an Output channel, reconnecting after each deploy
- Remote control in the sidebar, plus a capture pad that sends your keystrokes to the TV
- Live preview that refreshes about once a second, with keyboard and paste support
- Watch mode to redeploy on save, deploy history for rollback, and multi-device deploy
- Screenshot capture, with automatic pruning of saved images
- An MCP server so AI agents can drive the same workflow without VS Code running
- Packaging and image resizing run in pure JavaScript, so the extension works on
  macOS, Linux and Windows
