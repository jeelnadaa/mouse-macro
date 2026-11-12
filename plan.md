# AetherMacro: Product & Architecture Plan (v2)

> Stack-agnostic. Scope: mouse and keyboard automation for windowed and borderless-fullscreen apps.
> What changed from v1: sharper execution engine, a validator that catches mistakes before a run, undo everywhere, recorder cleanup tools, and a run log. Every v1 feature is kept.

---

## 1. Vision

A precision automation tool that is easy to author and hard to misuse.

1. **In-situ authoring.** Build steps by pointing at the running app. Never type a coordinate unless you want to.
2. **Zones, not pixels.** Every target is a point, circle, rectangle or polygon, sampled with a distribution.
3. **Two recording styles.** Discrete steps for structure, continuous capture for motion.
4. **Humanized by default.** Timing, path and position all vary within bounds the user controls.
5. **Always stoppable.** Safety is the first feature built, not the last.

### Product principles
- **Preview before commit.** Anything that moves the cursor can be previewed as a ghost first.
- **Nothing is destructive.** Undo and redo on every edit, autosave on every change, versioned profiles.
- **Explain failures.** Every abort, guard timeout and warning states what happened and what to try.
- **Quiet by default.** Overlays are click-through, translucent and dismiss themselves.

---

## 2. Architecture

```
Authoring layer     Capture overlay | Recorder | Step inspector | Library
        |
Profile model       Schema v2 | Validator (linter) | Undo history | Autosave
        |
Execution core      Sequence runner | Geometry sampler | Humanizer | Guard evaluator
        |
Platform layer      Input dispatcher | Window tracker | Hotkey manager | Screen reader | Overlay host
        |
Observability       Run log | Telemetry HUD | Status pill | Audio cues
```

Rules: the profile model has no UI or OS dependencies. The platform layer is the only code that touches OS APIs. The runner talks to the platform layer through an interface so it can run against a simulated dispatcher (used by dry runs and tests).

---

## 3. Window and coordinate lifecycle

- All geometry is saved in **client-area coordinates** (no title bar or border), with normalized values (`nx = x / width`) stored next to raw pixels.
- **Window tracking:** the coordinate matrix follows the window across moves and monitors.
- **Resize policy** per profile: anchor top-left, anchor center, or scale proportionally. A warning chip appears when the window size differs from the size the profile was authored at.
- **Per-monitor DPI** is resolved from virtual screen bounds on every dispatch.
- **Focus policy:** raise the window before dispatching, or pause. **Pause on minimize** and resume on restore.
- **Window picker:** point-and-click picker plus a recent targets list. Match by process name first, title second, so a title change mid-session does not break a run.

---

## 4. Authoring

### 4.1 Step mode (primary)
1. Hover the target and press `F8`. The frame freezes with a soft blur.
2. Pick a shape, drag it out, choose action and distribution.
3. `Enter` saves and returns focus to the app. Cursor travel between captures is discarded.

Improvements over v1:
- **Silent quick-add** (`F7`): drops a point step with defaults, no overlay.
- **Shape handles:** drag vertices and edges after drawing, `Shift` locks aspect, `Alt` draws from center.
- **Snap and nudge:** arrow keys move 1 px, `Shift`+arrow 10 px. Optional snapping to detected UI edges.
- **Test hits:** 35 sample points animate inside the shape so the distribution can be judged visually.
- **Reuse a zone:** copy a zone from any earlier step instead of redrawing.
- **Insert anywhere:** captures can be inserted between steps, not only appended.

### 4.2 Continuous recorder
- Samples position at 60 or 120 Hz with button timings and modifiers.
- **New:** trim leading and trailing idle time, smooth jitter with a single slider, and collapse a recording into one step or into a set of steps split at button events.
- **New:** a path preview shows kept and trimmed segments before saving.

### 4.3 Manual and inspector mode
Direct entry for coordinates, radius, bounds, delays and retries, with live validation and the same distribution preview used elsewhere.

### 4.4 Sequence editing (new)
- Reorder by drag, multi-select, copy, paste, duplicate.
- **Enable or disable** a step without deleting it.
- **Groups:** collapse several steps and repeat the group N times.
- **Undo and redo** with a visible history.
- **Run from here**, **run only this step**, and **run to here** from the step menu.
- The **pass bar** (one segment per step, width proportional to time) shows where time goes.
- **Mapped Areas 2D Canvas (`#seq-map-box`):** interactive 2D spatial canvas projecting target window bounds, all mapped zones (rect, circle, poly, point) in shape colors, step badges, and directional flow vectors. Supports click-to-inspect zone navigation and 3 layout modes: *Overview & Map*, *List only*, *Map only*.

### 4.5 Macro creation & switching
- **Quick New Macro:** one-click "+ New Macro" in sidebar and sequence header, plus global <kbd>Ctrl+N</kbd> keyboard shortcut.
- **Active Macro Switcher:** persistent selector in sidebar and sequence header with an emerald `● ACTIVE` badge and zero-latency Rust backend state synchronization.

---

## 5. Zones and sampling

Types: point, circle, rectangle, polygon.

| Setting | Behavior |
| :--- | :--- |
| Uniform | Even coverage of the area |
| Gaussian | Weighted to the centroid, spread tied to shape size, rejection-sampled to stay inside |
| Edge margin | Keeps samples away from the border |
| **Anti-repeat (new)** | Rejects a point closer than N px to the previous hit |
| **Heatmap (new)** | After a run, shows where hits landed so the spread can be tuned |

---

## 6. Actions and humanization

**Mouse:** click (left, right, middle, X1, X2), double click, hold, drag and drop, scroll (vertical and horizontal, randomized ticks).
**Keyboard:** tap, combo, hold, text injection with randomized intervals.

**Trajectory:** teleport, or Bézier with ease-in and ease-out. New options: overshoot and correct, speed scaled by distance (Fitts-style), and a curvature range.

**Timing:** fixed, uniform range, or Gaussian with clamping. Mean delay and spread/jitter settings on every step with live numeric inspector inputs, distribution curve previews, and comprehensive tooltips across the UI.

**Session realism (new):** optional slow drift in speed over a long run, and scheduled micro-breaks (for example a 2 to 6 second pause every 8 to 15 passes).

**Visual guards:**
- Pixel color within ΔE tolerance, with a multi-pixel option (3 sample points, majority wins) to survive anti-aliasing.
- Wait-until with timeout.
- On timeout: retry N times, skip, jump back, pause, or alert and halt.

---

## 7. Execution control

- **Loop modes:** infinite, N iterations, timed duration, and until-guard-matches.
- **Dry run (new):** moves a ghost cursor through the whole sequence on the overlay without sending input. Reports estimated pass time.
- **Step-through** with `F11`.
- **Pre-flight validator (new):** runs before every start and lists problems with a one-click fix:
  - delays under 10 ms or zero position spread (robotic pattern)
  - zones outside the current window bounds
  - hotkeys that clash with the target app
  - guards with no timeout policy
  - window size differs from the authored size
- **Run log (new):** per pass and per step timing, guard results, sampled points and abort reason. Exportable.

---

## 8. Safety

- **Emergency stop** (`Esc` or `F12`): all dispatch ends in under 5 ms, every held button and modifier is released, and a summary dialog confirms it.
- **Corner slam** failsafe on any physical screen corner.
- **User input override:** yield or pause when the real mouse moves during a path.
- **Focus guard:** never click if the target is not the foreground window.
- **Stuck-key sweep** runs on abort, crash and app exit.

---

## 9. Overlays and feedback

- **Zones Guide Overlay** (`F4`): Topmost transparent click-through HUD floating directly over the target window. Projects mapped hitboxes, step order tags, and zone contours in real time for manual play and timing assistance without focus-stealing or anti-cheat risk.
- **Telemetry HUD** (`F9`): client and screen coordinates, color under cursor, 7×7 loupe, target process and focus state. Click-through. `Ctrl+Shift+C` copies coordinates and hex.
- **Status pill** (`F10`): state, pass count, elapsed time, step segments, next action countdown, hotkey hints. Draggable, adjustable opacity, auto-hide, or fully headless.
- **Audio cues:** start 880 Hz, pause double beep, stop 440 Hz, alert 220 Hz, each with volume and mute.

---

## 10. Hotkeys

| Category | Default | Action |
| :--- | :--- | :--- |
| Overlay & Guide | `F4` | Toggle In-Game Zones Guide Overlay (manual play) |
| Execution | `F5` | Start or resume |
| Execution | `F6` | Pause |
| Execution | `F11` | Step through |
| Safety | `Esc` or `F12` | Emergency stop |
| Authoring | `F7` | Silent quick-add |
| Authoring | `F8` | Capture overlay |
| Authoring | `Ctrl+N` | Create and open new macro profile |
| Authoring | `Ctrl+Shift+R` | Start or stop recording |
| Diagnostics | `F9` | Telemetry HUD |
| Diagnostics | `F10` | Status pill |

A conflict database flags bindings that collide with common game or OS shortcuts. Rebinding is press-to-record. Profiles may override global defaults.

---

## 11. Macro library (multiple macros)

A user can save any number of macros. Each macro is an independent profile with its own steps, target window, loop policy and run history.

- **Library screen:** one row per macro with name, target app, active indicator badge, step count, a mini pass bar, total pass time, last run, and a primary "Select & Use" action. Search by name or target. The macro currently open is marked with a brass edge.
- **Persistent Macro Switcher:** Header dropdowns in both the sidebar (`#side-macro-sel`) and the Sequence view (`#seq-macro-sel`) allow instant switching between profiles from any view.
- **Rust Backend Synchronization:** Active macro state is stored synchronously in `AppState.active_macro` via `set_active_macro` / `get_active_macro` Tauri commands, guaranteeing zero-latency cross-window coherence with the in-game guide overlay.
- **Quick New Macro:** Prominent `+ New Macro` buttons in sidebar and sequence header, plus <kbd>Ctrl+N</kbd> global shortcut.
- **Create, open, rename, duplicate, delete.** Rename inline from the sequence title. Duplicate makes an independent copy named "<name> copy" with its run history cleared. A new macro starts empty with a placeholder name ("Untitled macro 1", then 2, and so on) and the name field selected.
- **Always at least one macro.** Deleting the last one is blocked.
- **Autosave on every change.** Create, edit, reorder, rename and delete all save immediately. No save button.
- **Undo across the library.** `Ctrl+Z` reverses the last 50 changes, including a deleted step or macro.
- **Storage:** one file per macro plus a small index (active macro, ordering, last-run times). A corrupt macro file never blocks the others; it is listed as "Needs repair" with a restore-from-version action.
- **Versions:** each macro keeps snapshots (on open, on run, and every 10 minutes of edits). Restore any snapshot into a copy or in place.
- **Import and export:** one macro as JSON or YAML, or the whole library as a bundle. Imports pass through the validator, and name clashes are resolved by appending "copy".
- **Per-macro settings:** target window, resize policy, loop policy, humanization and optional hotkey overrides live inside the macro. Global hotkeys are the default.
- **Run rules:** only one macro runs at a time. While a macro runs, opening another is allowed for editing but starting it is blocked with a message naming the running macro. Emergency stop always ends whatever is running.
- **Macro chaining (phase 5):** a step type "Run macro" calls another macro, with a depth limit of 3 and cycle detection in the validator.
- **Tags and folders (later):** optional, only once libraries are large enough to need them.

### Schema v2 (additions marked)

```json
{
  "profile_name": "Smithing_Loop",
  "version": "2.0",
  "authored_window": { "width": 1920, "height": 1080 },
  "target_window": { "process": "eldenring.exe", "title_match": "ELDEN RING", "match_mode": "contains", "require_focus": true, "on_resize": "scale" },
  "execution_settings": { "loop_mode": "count", "loop_count": 50, "micro_breaks": { "every_passes": [8, 15], "pause_ms": [2000, 6000] }, "humanize_trajectories": true },
  "steps": [
    {
      "step_id": 1,
      "enabled": true,
      "group": null,
      "description": "Open merchant dialogue",
      "action_type": "click",
      "button": "left",
      "target_geometry": { "type": "rectangle", "bounds": { "x": 420, "y": 680, "width": 120, "height": 45 }, "sampling_distribution": "gaussian", "edge_padding_px": 4, "min_distance_from_last_px": 6 },
      "hold_duration_ms": { "min": 45, "max": 75 },
      "delay_after_ms": { "distribution": "gaussian", "mean": 850, "sigma": 90, "clamp_sigmas": 2 },
      "guard": { "type": "pixel_color", "samples": [{ "x": 430, "y": 690 }], "expected_hex": "#4A90E2", "tolerance": 12, "timeout_ms": 2500, "on_timeout": { "action": "retry", "times": 3, "then": "pause" } }
    }
  ]
}
```

---

## 12. Edge cases

| Case | Risk | Mitigation |
| :--- | :--- | :--- |
| Window resized | Zones drift | Resize policy plus warning chip |
| Window minimized or covered | Clicks hit other apps | Focus guard, auto pause |
| Anti-cheat or raw input | Synthetic clicks ignored | Hardware-level scan codes and native packets |
| Kernel anti-cheat (e.g. Vanguard) | Injected cursor movement blocked | Zones Guide Overlay (<kbd>F4</kbd>) projects live visual hitboxes for 100% natural manual play with zero ban risk |
| Hotkey collision | Game receives macro keys | Conflict database, rebinding |
| Mixed DPI monitors | Offsets wrong | Per-monitor scaling on each dispatch |
| App crash mid-run | Stuck keys | Stuck-key sweep, run log preserved |

---

## 13. Delivery phases

1. **Core:** window binding, step capture, zones and sampling, runner, hotkeys, emergency stop.
2. **Authoring polish:** inspector, shape handles, undo, step menu, validator.
3. **Realism and guards:** Bézier options, Gaussian timing, pixel guards, micro-breaks.
4. **Recorder and overlays:** continuous recording with trim and smooth, telemetry HUD, status pill, audio.
5. **Library and diagnostics:** multi-macro library with autosave and undo, version history, import and export, run log, heatmap, dry run, macro chaining.
6. **In-game assistance & spatial mapping:** Zones Guide Overlay (<kbd>F4</kbd>), Sequence 2D visual canvas with layout toggles, multi-macro switcher, and automated test harness.

### Acceptance targets
- Emergency stop under 5 ms, verified with the simulated dispatcher.
- Any number of macros can be saved, switched between and restored after a restart with no data loss.
- A step can be captured in under 3 seconds from hotkey to saved.
- Profiles round-trip through export and import without loss.
- The validator catches every item listed in section 7 on a seeded bad profile.
- Automated UI and backend test suites pass with zero regressions.

---

## 14. Feature matrix

- [x] Window-relative coordinates, resize policy, per-monitor DPI
- [x] Step capture, silent quick-add, continuous recorder with trim and smooth
- [x] Manual inspector with nudging and live distribution preview
- [x] Precision delay controls (mean duration + spread jitter) with tooltips
- [x] Point, circle, rectangle, polygon zones with uniform and Gaussian sampling
- [x] Anti-repeat sampling and post-run heatmap
- [x] Mapped Areas 2D visual canvas with layout modes (*Overview & Map*, *List only*, *Map only*) and click-to-inspect
- [x] In-Game Zones Guide Overlay (<kbd>F4</kbd>) for manual play and timing assistance
- [x] Full action set and Bézier trajectories with overshoot
- [x] Pixel guards with multi-sample and fallback policies
- [x] Undo, redo, groups, enable and disable, run from here
- [x] Dry run, pre-flight validator, run log
- [x] Emergency stop, corner slam, focus guard, stuck-key sweep
- [x] Telemetry HUD, status pill, audio cues
- [x] Hotkey manager with conflict detection
- [x] Multi-macro library: create, open, rename, duplicate, delete, search, autosave, undo
- [x] Persistent macro switcher (sidebar & sequence header) with synchronous Rust backend state persistence
- [x] Quick macro creation (+ New Macro buttons and <kbd>Ctrl+N</kbd> shortcut)
- [x] Versioning, per-macro settings, import and export, portable schema
- [x] Automated test harness: Rust backend tests (`cargo test`) and UI automated suite (`node --test`)

---

## 15. Automated Testing & Verification Harness

- **Backend Rust Tests (`src-tauri/`):**
  - Model serialization, deserialization, and default integrity (`src/model.rs`).
  - Zone geometric bounds sampling and centroid containment (`src/sampler.rs`).
  - Timing clamp constraints (`src/sampler.rs`).
  - Run via: `cargo test --manifest-path src-tauri/Cargo.toml`.
- **Frontend UI Test Suite (`tests/ui_test.mjs`):**
  - DOM structure validation for static elements across main interface (`ui/index.html`) and overlay (`ui/overlay.html`).
  - Multi-macro selector generation and active status pill verification.
  - 2D canvas coordinate projections, aspect-ratio scaling, and SVG geometry generation.
  - Overlay coordinate fallback mappings between game client areas and fullscreen dimensions.
  - Run via: `npm test` or `node --test tests/ui_test.mjs`.
