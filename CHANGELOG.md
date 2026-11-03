# Changelog

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
