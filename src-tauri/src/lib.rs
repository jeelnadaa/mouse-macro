mod model;
mod platform;
mod runner;
mod sampler;
mod store;

use model::Macro;
use platform::WinInfo;
use runner::{Engine, RunRequest};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, Serialize, Default)]
struct Geom {
    /// Native screen coordinates of the overlay's top-left corner.
    ox: f64,
    oy: f64,
    /// Native units per CSS pixel.
    k: f64,
}

#[derive(Default)]
struct AppState {
    engine: Engine,
    cache: store::Cache,
    hotkeys: Mutex<HashMap<u32, String>>,
    stop_keys: Mutex<Vec<Shortcut>>,
    stop_bindings: Mutex<Vec<String>>,
    target: Mutex<(String, String)>,
    capture_win: Mutex<Option<WinInfo>>,
    geom: Mutex<Geom>,
    recording: Arc<AtomicBool>,
    record_hz: AtomicU32,
    update: Mutex<Option<Update>>,
}

fn st(app: &AppHandle) -> State<'_, AppState> {
    app.state::<AppState>()
}

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("overlay")
}

fn hwnd_of(_w: &WebviewWindow) -> u64 {
    #[cfg(windows)]
    {
        return _w.hwnd().map(|h| h.0 as usize as u64).unwrap_or(0);
    }
    #[allow(unreachable_code)]
    0
}

/// Moves the overlay onto the monitor that holds `at` (native coordinates)
/// and records the mapping between CSS pixels and native screen units.
fn place_overlay(app: &AppHandle, at: (i32, i32)) -> Geom {
    let Some(ov) = overlay(app) else { return Geom::default() };
    let monitors = ov.available_monitors().unwrap_or_default();
    let native = |m: &tauri::Monitor| -> (f64, f64, f64, f64, f64) {
        let p = m.position();
        let s = m.size();
        let sf = m.scale_factor();
        if cfg!(target_os = "macos") {
            (p.x as f64 / sf, p.y as f64 / sf, s.width as f64 / sf, s.height as f64 / sf, 1.0)
        } else {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64, sf)
        }
    };
    let pick = monitors
        .iter()
        .find(|m| {
            let (x, y, w, h, _) = native(m);
            (at.0 as f64) >= x && (at.0 as f64) < x + w && (at.1 as f64) >= y && (at.1 as f64) < y + h
        })
        .or_else(|| monitors.first())
        .cloned()
        .or_else(|| ov.primary_monitor().ok().flatten());
    let Some(m) = pick else { return Geom::default() };
    let (x, y, _, _, k) = native(&m);
    let _ = ov.set_position(PhysicalPosition::new(m.position().x, m.position().y));
    let _ = ov.set_size(PhysicalSize::new(m.size().width, m.size().height));
    let g = Geom { ox: x, oy: y, k };
    *st(app).geom.lock().unwrap() = g;
    let _ = app.emit_to("overlay", "overlay-geom", g);
    g
}

fn overlay_set(app: &AppHandle, visible: bool, interactive: bool) {
    let Some(ov) = overlay(app) else { return };
    if !visible {
        let _ = ov.set_ignore_cursor_events(true);
        let _ = ov.hide();
        return;
    }
    let _ = ov.set_ignore_cursor_events(!interactive);
    let _ = ov.set_focusable(interactive);
    if cfg!(windows) {
        platform::show_no_activate(hwnd_of(&ov), interactive);
    } else {
        let _ = ov.show();
        let _ = ov.set_always_on_top(true);
    }
    if interactive {
        let _ = ov.set_focus();
    }
}

/// The window the user is pointing the tool at: the foreground app, or the
/// open macro's target when AetherMacro itself is in front.
fn pick_target(app: &AppHandle) -> Option<WinInfo> {
    let fg = platform::foreground_window();
    if let Some(w) = &fg {
        if !platform::is_own(w) {
            return fg;
        }
    }
    let (p, t) = st(app).target.lock().unwrap().clone();
    if p.is_empty() {
        return platform::find_window("", "");
    }
    let w = platform::find_window(&p, &t)?;
    platform::focus_window(w.id);
    Some(w)
}

/// The open macro's target window, raised to the front.
fn target_window(app: &AppHandle) -> Option<WinInfo> {
    let (p, t) = st(app).target.lock().unwrap().clone();
    if p.is_empty() {
        return None;
    }
    let w = platform::find_window(&p, &t)?;
    platform::focus_window(w.id);
    std::thread::sleep(Duration::from_millis(80));
    Some(w)
}

fn toast_overlay(app: &AppHandle, text: &str) {
    let _ = app.emit_to("overlay", "overlay-toast", text);
}

// ------------------------------------------------------------ hotkeys

fn register_hotkeys(app: &AppHandle, map: &HashMap<String, String>) -> Vec<Value> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state = st(app);
    let mut ids = state.hotkeys.lock().unwrap();
    ids.clear();
    let mut stop_bindings = state.stop_bindings.lock().unwrap();
    stop_bindings.clear();
    let mut out = vec![];
    for (action, keys) in map {
        let keys = keys.trim();
        if keys.is_empty() {
            continue;
        }
        if action.starts_with("stop") {
            // Stop keys (Esc by default) are only taken while a macro runs, so
            // the game keeps them the rest of the time.
            for k in keys.split(',') {
                stop_bindings.push(k.trim().to_string());
            }
            out.push(json!({ "action": action, "keys": keys, "ok": true }));
            continue;
        }
        let res = keys.parse::<Shortcut>().map_err(|e| e.to_string()).and_then(|s| {
            gs.register(s).map_err(|e| e.to_string())?;
            Ok(s)
        });
        match res {
            Ok(s) => {
                ids.insert(s.id(), action.clone());
                out.push(json!({ "action": action, "keys": keys, "ok": true }));
            }
            Err(e) => out.push(json!({ "action": action, "keys": keys, "ok": false, "error": e })),
        }
    }
    out
}

fn arm_stop_keys(app: &AppHandle, on: bool) {
    let state = st(app);
    let gs = app.global_shortcut();
    let mut armed = state.stop_keys.lock().unwrap();
    for s in armed.drain(..) {
        let _ = gs.unregister(s);
    }
    if !on {
        return;
    }
    let mut ids = state.hotkeys.lock().unwrap();
    for k in state.stop_bindings.lock().unwrap().iter() {
        if let Ok(s) = k.parse::<Shortcut>() {
            if gs.register(s).is_ok() {
                ids.insert(s.id(), "stop".into());
                armed.push(s);
            }
        }
    }
}

fn on_hotkey(app: &AppHandle, id: u32) {
    let action = st(app).hotkeys.lock().unwrap().get(&id).cloned();
    let Some(action) = action else { return };
    let engine = st(app).engine.clone();
    match action.as_str() {
        "stop" => engine.stop("user", "You pressed the emergency stop key."),
        "pause" => {
            if engine.is_running() {
                if engine.status().state == "paused" {
                    engine.resume();
                } else {
                    engine.pause(app);
                }
            }
        }
        "start" => {
            if engine.is_running() {
                engine.resume();
            } else {
                let _ = app.emit_to("main", "hotkey", "start");
            }
        }
        "step" => {
            if engine.is_running() {
                engine.step();
            } else {
                let _ = app.emit_to("main", "hotkey", "step");
            }
        }
        "capture" => begin_capture_inner(app, false),
        "quick" => quick_add(app),
        "record" => toggle_record(app),
        "hud" | "pill" | "zones" => {
            let _ = app.emit("overlay-toggle", action.as_str());
            let at = platform::cursor_pos();
            place_overlay(app, at);
        }
        _ => {}
    }
}

// ------------------------------------------------------------ capture

fn begin_capture_inner(app: &AppHandle, from_ui: bool) {
    if st(app).engine.is_running() {
        toast_overlay(app, "Stop the running macro before capturing a step.");
        return;
    }
    let picked = if from_ui { target_window(app).or_else(|| pick_target(app)) } else { pick_target(app) };
    let Some(w) = picked else {
        let _ = app.emit_to("main", "toast", "Open the target app first, then press F8 over it.");
        return;
    };
    let g = place_overlay(app, (w.x + w.w / 2, w.y + w.h / 2));
    *st(app).capture_win.lock().unwrap() = Some(w.clone());
    let _ = app.emit_to("overlay", "capture-begin", json!({ "win": w, "geom": g }));
    overlay_set(app, true, true);
}

fn quick_add(app: &AppHandle) {
    let Some(w) = pick_target(app) else { return };
    let (cx, cy) = platform::cursor_pos();
    if platform::is_own(&w) || cx < w.x || cy < w.y || cx >= w.x + w.w || cy >= w.y + w.h {
        toast_overlay(app, "Hover the target window, then press F7.");
        return;
    }
    let _ = app.emit_to("main", "quick-add", json!({ "x": cx - w.x, "y": cy - w.y, "win": w }));
}

// ------------------------------------------------------------ recorder

fn toggle_record(app: &AppHandle) {
    let state = st(app);
    if state.recording.swap(false, SeqCst) {
        return; // the recorder thread sees the flag and finishes
    }
    if state.engine.is_running() {
        toast_overlay(app, "Stop the running macro before recording.");
        return;
    }
    let Some(w) = pick_target(app) else { return };
    let hz = state.record_hz.load(SeqCst).clamp(30, 240);
    let flag = state.recording.clone();
    flag.store(true, SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = app.emit("record-state", json!({ "recording": true, "started": runner::now_ms(), "process": w.process }));
        let t0 = Instant::now();
        let period = Duration::from_secs_f64(1.0 / hz as f64);
        let mut pts: Vec<[f64; 4]> = vec![];
        let mut next = Instant::now();
        while flag.load(SeqCst) && t0.elapsed() < Duration::from_secs(600) {
            let (x, y) = platform::cursor_pos();
            let b = platform::button_state();
            pts.push([(x - w.x) as f64, (y - w.y) as f64, t0.elapsed().as_secs_f64() * 1000.0, b as f64]);
            next += period;
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            }
        }
        flag.store(false, SeqCst);
        let _ = app.emit("record-state", json!({ "recording": false }));
        let _ = app.emit("recording", json!({ "points": pts, "hz": hz, "win": w }));
    });
}

// ------------------------------------------------------------ commands

#[tauri::command]
fn load_library(app: AppHandle, state: State<AppState>) -> store::Library {
    store::load_library(&app, &state.cache)
}

#[tauri::command]
fn save_library(app: AppHandle, state: State<AppState>, macros: Vec<Macro>, index: Value) -> Result<(), String> {
    store::save_library(&app, &state.cache, &macros, &index)
}

#[tauri::command]
fn load_prefs(app: AppHandle) -> Value {
    store::load_prefs(&app)
}

#[tauri::command]
fn save_prefs(app: AppHandle, state: State<AppState>, prefs: Value) -> Result<(), String> {
    if let Some(hz) = prefs.get("record_hz").and_then(|v| v.as_u64()) {
        state.record_hz.store(hz as u32, SeqCst);
    }
    store::save_prefs(&app, &prefs)
}

#[tauri::command]
fn apply_hotkeys(app: AppHandle, map: HashMap<String, String>) -> Vec<Value> {
    register_hotkeys(&app, &map)
}

#[tauri::command]
fn load_runs(app: AppHandle) -> Value {
    store::load_runs(&app)
}

#[tauri::command]
fn clear_runs(app: AppHandle) {
    store::clear_runs(&app)
}

#[tauri::command]
fn export_file(app: AppHandle, name: String, content: String) -> Result<String, String> {
    store::export(&app, &name, &content)
}

fn start_dir(app: &AppHandle, dir: &str) -> std::path::PathBuf {
    let d = std::path::PathBuf::from(dir);
    if !dir.is_empty() && d.is_dir() { d } else { store::default_save_dir(app) }
}

fn clean_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || " -_.()".contains(c) { c } else { '_' }).collect();
    let s = s.trim().to_string();
    if s.is_empty() { "macro.json".into() } else if s.to_lowercase().ends_with(".json") { s } else { format!("{s}.json") }
}

#[tauri::command]
fn default_save_dir(app: AppHandle) -> String {
    store::default_save_dir(&app).display().to_string()
}

/// Native "Save as" dialog. Returns the chosen path, or None when cancelled.
#[tauri::command]
async fn save_file_as(app: AppHandle, content: String, name: String, dir: String) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Save macro")
        .set_directory(start_dir(&app, &dir))
        .set_file_name(clean_name(&name))
        .add_filter("AetherMacro JSON", &["json"])
        .blocking_save_file();
    let Some(p) = picked else { return Ok(None) };
    let mut path = p.into_path().map_err(|e| e.to_string())?;
    if path.extension().is_none() {
        path.set_extension("json");
    }
    std::fs::write(&path, content).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// Writes to a path the user already chose with Save as.
#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("The folder {} no longer exists.", parent.display()));
        }
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Native "Open" dialog for one or more macro files.
#[tauri::command]
async fn open_files(app: AppHandle, dir: String) -> Result<Vec<Value>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open macros")
        .set_directory(start_dir(&app, &dir))
        .add_filter("AetherMacro JSON", &["json"])
        .blocking_pick_files()
        .unwrap_or_default();
    let mut out = vec![];
    for f in picked {
        let p = f.into_path().map_err(|e| e.to_string())?;
        let content = std::fs::read_to_string(&p).map_err(|e| format!("Could not read {}: {e}", p.display()))?;
        out.push(json!({ "path": p.display().to_string(), "content": content }));
    }
    Ok(out)
}

/// Native folder picker for the default save folder.
#[tauri::command]
async fn pick_folder(app: AppHandle, dir: String) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose the default folder for saved macros")
        .set_directory(start_dir(&app, &dir))
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
fn run_start(app: AppHandle, state: State<AppState>, req: RunRequest) -> Result<(), String> {
    let p = req.mac.target.process.clone();
    let at = if p.is_empty() { platform::cursor_pos() } else {
        platform::find_window(&p, &req.mac.target.title).map(|w| (w.x + w.w / 2, w.y + w.h / 2)).unwrap_or_else(platform::cursor_pos)
    };
    place_overlay(&app, at);
    state.engine.start(app.clone(), req)?;
    arm_stop_keys(&app, true);
    Ok(())
}

#[tauri::command]
fn run_stop(state: State<AppState>) {
    state.engine.stop("stopped", "You stopped the run.");
}

#[tauri::command]
fn run_pause(app: AppHandle, state: State<AppState>) {
    state.engine.pause(&app);
}

#[tauri::command]
fn run_resume(state: State<AppState>) {
    state.engine.resume();
}

#[tauri::command]
fn run_step(state: State<AppState>) {
    state.engine.step();
}

#[tauri::command]
fn run_status(state: State<AppState>) -> runner::Status {
    state.engine.status()
}

#[tauri::command]
fn set_active_target(state: State<AppState>, process: String, title: String) {
    *state.target.lock().unwrap() = (process, title);
}

#[tauri::command]
fn list_windows() -> Vec<WinInfo> {
    platform::list_windows()
}

#[tauri::command]
fn target_info(process: String, title: String) -> Option<WinInfo> {
    platform::find_window(&process, &title)
}

#[tauri::command]
fn begin_capture(app: AppHandle) {
    begin_capture_inner(&app, true);
}

#[tauri::command]
fn capture_end(app: AppHandle, state: State<AppState>, step: Option<Value>, guard_at: Option<[f64; 2]>) {
    let win = state.capture_win.lock().unwrap().take();
    overlay_set(&app, false, false);
    let Some(w) = win else { return };
    if w.id != 0 {
        platform::focus_window(w.id);
    }
    if let Some(mut step) = step {
        if let Some([gx, gy]) = guard_at {
            // Read after the overlay is gone so its dim layer is never sampled.
            std::thread::sleep(Duration::from_millis(60));
            if let Some(px) = platform::read_pixels(w.x + gx as i32, w.y + gy as i32, 1, 1) {
                step["guard"] = json!({
                    "samples": [[gx, gy]], "hex": sampler::to_hex(px[0]), "tolerance": 12.0,
                    "timeout_ms": 2500.0, "on_timeout": "retry", "retries": 3
                });
            }
        }
        let _ = app.emit_to("main", "capture-step", json!({ "step": step, "win": w }));
    }
}

#[tauri::command]
fn overlay_mode(app: AppHandle, visible: bool, interactive: bool) {
    if visible && !interactive {
        let g = *st(&app).geom.lock().unwrap();
        if g.k == 0.0 {
            place_overlay(&app, platform::cursor_pos());
        }
    }
    overlay_set(&app, visible, interactive);
}

#[tauri::command]
fn overlay_geom(state: State<AppState>) -> Geom {
    *state.geom.lock().unwrap()
}

#[derive(Serialize)]
struct HudSample {
    screen: (i32, i32),
    client: Option<(i32, i32)>,
    colors: Vec<String>,
    process: String,
    focused: bool,
}

#[tauri::command]
fn hud_sample(state: State<AppState>) -> HudSample {
    let (x, y) = platform::cursor_pos();
    let colors = platform::read_pixels(x - 3, y - 3, 7, 7).map(|v| v.into_iter().map(sampler::to_hex).collect()).unwrap_or_default();
    let (p, t) = state.target.lock().unwrap().clone();
    let w = if p.is_empty() { platform::foreground_window().filter(|w| !platform::is_own(w)) } else { platform::find_window(&p, &t) };
    let client = w.as_ref().map(|w| (x - w.x, y - w.y));
    HudSample {
        screen: (x, y),
        client,
        colors,
        process: w.as_ref().map(|w| w.process.clone()).filter(|p| !p.is_empty()).unwrap_or_else(|| "Whole screen".into()),
        focused: w.as_ref().map_or(false, |w| platform::is_foreground(w.id)),
    }
}

/// Reads the colour at a client point of the macro's target window.
#[tauri::command]
fn read_client_pixel(process: String, title: String, x: f64, y: f64, aw: f64, ah: f64) -> Option<String> {
    let w = platform::find_window(&process, &title)?;
    let (sx, sy) = if aw > 0.0 && ah > 0.0 { (x * w.w as f64 / aw, y * w.h as f64 / ah) } else { (x, y) };
    platform::read_pixels(w.x + sx as i32, w.y + sy as i32, 1, 1).map(|p| sampler::to_hex(p[0]))
}

#[tauri::command]
fn toggle_record_cmd(app: AppHandle) {
    toggle_record(&app);
}

#[tauri::command]
fn app_info(app: AppHandle) -> Value {
    json!({ "version": app.package_info().version.to_string(), "os": std::env::consts::OS })
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<Value>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|u| json!({ "version": u.version, "notes": u.body, "date": u.date.map(|d| d.to_string()) }));
    *st(&app).update.lock().unwrap() = found;
    Ok(info)
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let u = st(&app).update.lock().unwrap().take().ok_or("No update is waiting. Check again.")?;
    st(&app).engine.stop("stopped", "Stopped to install an update.");
    let a2 = app.clone();
    let mut got = 0usize;
    u.download_and_install(
        move |n, total| {
            got += n;
            let _ = a2.emit("update-progress", json!({ "got": got, "total": total }));
        },
        || {},
    )
    .await
    .map_err(|e| e.to_string())?;
    app.restart();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_hotkey(app, shortcut.id());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { record_hz: AtomicU32::new(60), ..Default::default() })
        .setup(|app| {
            let handle = app.handle().clone();
            let ov = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
                .title("AetherMacro overlay")
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .focused(false)
                .focusable(false)
                .visible(false)
                .build()?;
            let _ = ov.set_ignore_cursor_events(true);
            if std::env::var_os("AETHER_OVERLAY_CAPTURABLE").is_none() {
                platform::prepare_overlay(hwnd_of(&ov));
            }

            let prefs = store::load_prefs(&handle);
            if let Some(hz) = prefs.get("record_hz").and_then(|v| v.as_u64()) {
                st(&handle).record_hz.store(hz as u32, SeqCst);
            }

            let h2 = handle.clone();
            handle.listen("run-ended", move |_| arm_stop_keys(&h2, false));

            // Check GitHub releases for a newer build shortly after launch.
            let h3 = handle.clone();
            tauri::async_runtime::spawn(async move {
                std::thread::sleep(Duration::from_secs(4));
                if let Ok(Some(info)) = check_update(h3.clone()).await {
                    let _ = h3.emit_to("main", "update-available", info);
                }
            });
            Ok(())
        })
        .on_window_event(|win, ev| {
            if win.label() == "main" {
                if let WindowEvent::CloseRequested { .. } = ev {
                    let app = win.app_handle();
                    st(app).engine.stop("stopped", "AetherMacro closed.");
                    st(app).recording.store(false, SeqCst);
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            load_prefs,
            save_prefs,
            apply_hotkeys,
            load_runs,
            clear_runs,
            export_file,
            default_save_dir,
            save_file_as,
            write_file,
            open_files,
            pick_folder,
            run_start,
            run_stop,
            run_pause,
            run_resume,
            run_step,
            run_status,
            set_active_target,
            list_windows,
            target_info,
            begin_capture,
            capture_end,
            overlay_mode,
            overlay_geom,
            hud_sample,
            read_client_pixel,
            toggle_record_cmd,
            app_info,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running AetherMacro");
}
