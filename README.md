# AetherMacro

Humanized mouse and keyboard macros you build by pointing at the running app, with an overlay that floats above borderless-fullscreen games.

Built with Tauri 2 (Rust backend, plain HTML/JS frontend, no bundler). The Windows installer is about 2 MB.

## Features

- **Capture over the app (F8).** Draw a rectangle, circle, polygon or point zone right on top of the game. Press Enter to save the step and you are back in the game.
- **Quick add (F7).** Drops a click step at the pointer without opening the overlay.
- **Humanized runs.** Gaussian or uniform sampling inside zones, with edge margin and anti-repeat. Bézier pointer paths with optional overshoot and Fitts-style speed. Gaussian, uniform or fixed delays clamped at ±2σ. Optional micro-breaks.
- **Actions.** Left, right, middle and double click; hold; drag and drop; scroll; key taps and combos; typed text; move; wait; and recorded paths (Ctrl+Shift+R, 60 or 120 Hz, with trim and smoothing).
- **Pixel guards.** Before a step, wait for a colour (ΔE tolerance, optional 3-point majority vote). On timeout it can retry, skip, pause or halt.
- **Safety.** The emergency stop (Esc or F12) is only claimed while a macro runs. It releases every held button and key; abort latency is measured at about 1 to 2 ms. The run also stops if the pointer hits a screen corner. The focus guard pauses when the game loses focus or is minimized, and runs pause when you move the mouse yourself.
- **Overlay.** Click-through telemetry HUD (F9) and status pill (F10). Dry runs show a ghost cursor and send no input. The overlay never takes focus from the game and is hidden from screen capture, so it does not appear in streams or skew pixel guards.
- **Pre-flight validator.** Flags robotic timing, zero position spread, zones outside the window, steps that press your own hotkeys, guards without timeouts, and window-size changes. Most issues have a one-click fix.
- **Library.** Keeps any number of macros, with autosave and 50-step undo/redo (Ctrl+Z / Ctrl+Y). Save as writes to any folder (Ctrl+S re-saves to the same file, Ctrl+Shift+S picks a new one), and you can set the default folder. Open files from disk, plus a run log covering the last 30 runs.
- **Auto-update.** On launch the app checks GitHub Releases and updates in place, with signed packages.

## Games and anti-cheat

Input is sent with `SendInput` and hardware scan codes, which works in most games, including DirectInput titles. The overlay is a topmost transparent window, so it shows over **borderless or windowed fullscreen**. No overlay can draw over exclusive fullscreen, so switch the game's display mode.

Games with kernel anti-cheat (for example Valorant's Vanguard) can detect injected input. They may ignore it, and using macros may break the game's terms of service and get the account banned. AetherMacro does not try to hide from anti-cheat. Use it where automation is allowed.

## Platforms

| | Window tracking | Input | Pixel guards and HUD colour |
|---|---|---|---|
| Windows 10/11 | Per-window, follows moves, DPI-aware | SendInput with scan codes | Yes |
| macOS 10.15+ | Whole screen | enigo (needs Accessibility permission) | Yes (needs Screen Recording permission) |
| Linux (X11) | Whole screen | enigo over X11 | Yes |

Wayland sessions need XWayland. The macOS build is unsigned, so the first time you open it, right-click the app and choose Open.

## Develop

```bash
npm ci
```

```bash
npx tauri dev
```

```bash
cd src-tauri && cargo test --lib
```

Run the app with `AETHER_OVERLAY_CAPTURABLE=1` set to let screenshots include the overlay while testing.

## Release pipeline

`.github/workflows/release.yml` runs on every push to `main`:

1. Picks the version `MAJOR.MINOR.<run number>`, taking `MAJOR.MINOR` from `src-tauri/tauri.conf.json`, and creates a draft release.
2. Builds Windows (NSIS), macOS (universal `.app` and `.dmg`) and Linux (AppImage and `.deb`) in parallel, using Rust and npm caches.
3. Signs the updater packages, uploads them, writes `latest.json`, and publishes the release.

One-time setup: add the updater private key as the repository secret `TAURI_SIGNING_PRIVATE_KEY`. If the key has a password, also add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The matching public key is already in `tauri.conf.json`. Keep the private key safe: without it, installed copies cannot verify future updates.
