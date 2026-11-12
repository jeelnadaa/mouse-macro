# AetherMacro

Humanized mouse and keyboard macros you build by pointing at the running app, with an overlay that floats above borderless-fullscreen games.

Built with Tauri 2 (Rust backend, plain HTML/JS frontend, no bundler). The Windows installer is about 2 MB.

## Features

- **Capture over the app (F8).** Draw a rectangle, circle, polygon or point zone right on top of the game. Press Enter to save the step and you are back in the game.
- **Quick add (F7).** Drops a click step at the pointer without opening the overlay.
- **Mapped Areas 2D Canvas.** Dedicated interactive coordinate canvas in Sequence view showing target window bounds, all mapped zones (rect, circle, poly, point) with step numbers, and step-to-step directional flow lines. Features a 3-way layout toggle (*Overview & Map*, *List only*, *Map only*) and click-to-inspect zone navigation.
- **In-Game Zones Guide Overlay (F4).** Topmost click-through guide overlay floating directly over the game window. Projects the active macro's mapped hitboxes, step order numbers, and action tags in real time without stealing focus—ideal for manual execution, rapid lock-in, and training.
- **Definitive Macro Switcher & Quick New Macro.** Persistent profile switcher in the sidebar, active macro selector in the sequence header with `● ACTIVE` status badge, prominent `+ New Macro` buttons, and global <kbd>Ctrl+N</kbd> creation. State is synchronized synchronously in Rust backend memory (`AppState.active_macro`).
- **Precision Timing & Delay Controls.** Per-step delay controls (mean duration + spread/jitter) clamped at ±2σ, with live distribution previews and comprehensive tooltips across all controls.
- **Humanized runs.** Gaussian or uniform sampling inside zones, with edge margin and anti-repeat. Bézier pointer paths with optional overshoot and Fitts-style speed. Optional micro-breaks.
- **Actions.** Left, right, middle and double click; hold; drag and drop; scroll; key taps and combos; typed text; move; wait; and recorded paths (Ctrl+Shift+R, 60 or 120 Hz, with trim and smoothing).
- **Pixel guards.** Before a step, wait for a colour (ΔE tolerance, optional 3-point majority vote). On timeout it can retry, skip, pause or halt.
- **Safety.** The emergency stop (Esc or F12) is only claimed while a macro runs. It releases every held button and key; abort latency is measured at about 1 to 2 ms. The run also stops if the pointer hits a screen corner. The focus guard pauses when the game loses focus or is minimized, and runs pause when you move the mouse yourself.
- **Overlays.** Click-through telemetry HUD (F9), status pill (F10), and Zones Guide overlay (F4). Dry runs show a ghost cursor and send no input. Overlays never take focus from the game and are hidden from screen capture, so they do not appear in streams or skew pixel guards.
- **Pre-flight validator.** Flags robotic timing, zero position spread, zones outside the window, steps that press your own hotkeys, guards without timeouts, and window-size changes. Most issues have a one-click fix.
- **Library.** Keeps any number of macros, with autosave and 50-step undo/redo (Ctrl+Z / Ctrl+Y). Save as writes to any folder (Ctrl+S re-saves to the same file, Ctrl+Shift+S picks a new one), and you can set the default folder. Open files from disk, plus a run log covering the last 30 runs.
- **Auto-update.** On launch the app checks GitHub Releases and updates in place, with signed packages.

## Hotkey Reference

| Hotkey | Context | Action |
| :--- | :--- | :--- |
| <kbd>F4</kbd> | Global | Toggle In-Game Zones Guide Overlay (manual play / assistance) |
| <kbd>F5</kbd> | Global | Start or resume active macro |
| <kbd>F6</kbd> | Global | Pause running macro |
| <kbd>F7</kbd> | Global | Quick add point click step at current cursor position |
| <kbd>F8</kbd> | Global | Open in-situ capture overlay over target window |
| <kbd>F9</kbd> | Global | Toggle Telemetry HUD (magnifier, coordinates, pixel color) |
| <kbd>F10</kbd> | Global | Toggle Status Pill overlay |
| <kbd>F11</kbd> | Global | Step-through execution (advance one step) |
| <kbd>F12</kbd> / <kbd>Esc</kbd> | Global | Emergency Stop (releases all inputs within ~1–2 ms) |
| <kbd>Ctrl+N</kbd> | App | Create and switch to a new macro profile |
| <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> | App | Undo / Redo profile and step edits (up to 50 levels) |
| <kbd>Ctrl+Shift+R</kbd> | Global | Start or stop continuous path recording |

## Games and Anti-Cheat

Input is dispatched via Windows `SendInput` using direct hardware scan codes, which functions across standard desktop applications and games running in **borderless windowed** or **windowed** mode. (No overlay can draw over exclusive hardware fullscreen, so switch the game's display mode to borderless).

### Handling Kernel-Level Anti-Cheat (e.g., Valorant / Vanguard)
Modern competitive titles equipped with kernel-level driver anti-cheat (such as Riot Vanguard, BattlEye, or Easy Anti-Cheat) monitor and often suppress synthetic `SendInput` mouse movement packets originating from user-space processes.

To address this without compromising your system integrity or risking account sanctions:
- **Use the Zones Guide Overlay (<kbd>F4</kbd>):** Toggle the guide overlay while in-game. It projects your exact mapped click zones, agent lock-in coordinates, and step sequences directly onto the screen as a transparent, click-through HUD. You retain 100% natural mouse control and zero anti-cheat risk while gaining perfect visual spatial guidance.
- For non-kernel protected games and single-player titles, standard automated macro dispatch works out-of-the-box with humanized Gaussian curves and natural jitter.

## Platforms

| | Window tracking | Input | Pixel guards and HUD colour |
|---|---|---|---|
| Windows 10/11 | Per-window, follows moves, DPI-aware | SendInput with scan codes | Yes |
| macOS 10.15+ | Whole screen | enigo (needs Accessibility permission) | Yes (needs Screen Recording permission) |
| Linux (X11) | Whole screen | enigo over X11 | Yes |

Wayland sessions need XWayland. The macOS build is unsigned, so the first time you open it, right-click the app and choose Open.

## Develop & Test

```bash
# Install dependencies
npm ci

# Start the Tauri development desktop app
npm run dev

# Run the automated UI test suite (Node.js test runner)
npm test

# Run Rust backend unit tests
cargo test --manifest-path src-tauri/Cargo.toml
```

Run the app with `AETHER_OVERLAY_CAPTURABLE=1` set to let screenshots include the overlay while testing.

## Release Pipeline

`.github/workflows/release.yml` runs on every push to `main`:

1. Picks the version `MAJOR.MINOR.<run number>`, taking `MAJOR.MINOR` from `src-tauri/tauri.conf.json`, and creates a draft release.
2. Builds Windows (NSIS), macOS (universal `.app` and `.dmg`) and Linux (AppImage and `.deb`) in parallel, using Rust and npm caches.
3. Signs the updater packages, uploads them, writes `latest.json`, and publishes the release.

One-time setup: add the updater private key as the repository secret `TAURI_SIGNING_PRIVATE_KEY`. If the key has a password, also add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The matching public key is already in `tauri.conf.json`. Keep the private key safe: without it, installed copies cannot verify future updates.
