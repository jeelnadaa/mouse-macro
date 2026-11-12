//! Execution core: sequence runner, humanizer, guard evaluator and safety.
//! Talks to the OS only through `Disp`, which is either the real platform
//! input or a simulated dispatcher used by dry runs.

use crate::model::{Action, Macro, Step, Zone};
use crate::platform::{self, Btn, KeyId, WinInfo};
use crate::sampler::{self, Rng};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Status {
    /// "idle" | "running" | "paused" | "waiting" | "break"
    pub state: String,
    pub macro_id: String,
    pub macro_name: String,
    pub dry: bool,
    pub pass: u32,
    pub total_passes: Option<u32>,
    pub step: usize,
    pub step_count: usize,
    pub step_name: String,
    pub started: i64,
    pub step_started: i64,
    pub next_ms: f64,
    pub reason: String,
    pub process: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct LogEntry {
    pub pass: u32,
    pub step: usize,
    pub name: String,
    pub at_ms: f64,
    pub dur_ms: f64,
    pub point: Option<[i32; 2]>,
    pub guard: Option<String>,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Summary {
    pub macro_id: String,
    pub macro_name: String,
    /// "finished" | "user" | "corner" | "guard" | "stopped" | "error"
    pub reason: String,
    pub message: String,
    pub latency_ms: Option<f64>,
    pub released_buttons: Vec<String>,
    pub released_keys: Vec<String>,
    pub pass: u32,
    pub step: usize,
    pub step_name: String,
    pub elapsed_ms: f64,
    pub dry: bool,
    pub pass_ms: f64,
    pub started: i64,
    pub log: Vec<LogEntry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RunRequest {
    #[serde(rename = "macro")]
    pub mac: Macro,
    #[serde(default)]
    pub start: usize,
    #[serde(default)]
    pub only: bool,
    #[serde(default)]
    pub dry: bool,
    #[serde(default)]
    pub step_mode: bool,
}

#[derive(Default)]
struct Held {
    buttons: Vec<Btn>,
    keys: Vec<KeyId>,
}

#[derive(Default)]
pub struct Shared {
    pub running: AtomicBool,
    stop: AtomicBool,
    paused: AtomicBool,
    step_once: AtomicBool,
    swept: AtomicBool,
    stop_req: Mutex<Option<(Instant, String, String)>>,
    held: Mutex<Held>,
    released: Mutex<(Vec<String>, Vec<String>)>,
    pub status: Mutex<Status>,
}

#[derive(Clone, Default)]
pub struct Engine {
    pub sh: Arc<Shared>,
}

enum Halt {
    Stop,
}

type R<T> = Result<T, Halt>;

impl Engine {
    pub fn is_running(&self) -> bool {
        self.sh.running.load(SeqCst)
    }

    pub fn status(&self) -> Status {
        self.sh.status.lock().unwrap().clone()
    }

    pub fn start(&self, app: AppHandle, req: RunRequest) -> Result<(), String> {
        if self.sh.running.swap(true, SeqCst) {
            let name = self.sh.status.lock().unwrap().macro_name.clone();
            return Err(format!("{name} is already running. Stop it first."));
        }
        if !req.mac.steps.iter().any(|s| s.enabled) {
            self.sh.running.store(false, SeqCst);
            return Err("Add or enable a step first.".into());
        }
        self.sh.stop.store(false, SeqCst);
        self.sh.paused.store(false, SeqCst);
        self.sh.swept.store(false, SeqCst);
        self.sh.step_once.store(req.step_mode, SeqCst);
        *self.sh.stop_req.lock().unwrap() = None;
        *self.sh.held.lock().unwrap() = Held::default();
        *self.sh.released.lock().unwrap() = (vec![], vec![]);
        let sh = self.sh.clone();
        std::thread::Builder::new()
            .name("aether-runner".into())
            .spawn(move || run_thread(app, sh, req))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Emergency stop. Returns once every held input is released.
    pub fn stop(&self, reason: &str, message: &str) {
        if !self.sh.running.load(SeqCst) {
            return;
        }
        {
            let mut r = self.sh.stop_req.lock().unwrap();
            if r.is_none() {
                *r = Some((Instant::now(), reason.to_string(), message.to_string()));
            }
        }
        self.sh.stop.store(true, SeqCst);
        self.sh.paused.store(false, SeqCst);
        let t = Instant::now();
        while !self.sh.swept.load(SeqCst) && t.elapsed() < Duration::from_millis(25) {
            std::thread::sleep(Duration::from_micros(500));
        }
        if !self.sh.swept.load(SeqCst) {
            // Runner is stuck in a syscall; release from here so nothing stays held.
            sweep(&self.sh, &mut platform::Input::new());
        }
    }

    pub fn pause(&self, app: &AppHandle) {
        if self.is_running() && !self.sh.paused.swap(true, SeqCst) {
            self.sh.step_once.store(false, SeqCst);
            set_state(app, &self.sh, "paused", "Paused with F6");
        }
    }

    pub fn resume(&self) {
        self.sh.step_once.store(false, SeqCst);
        self.sh.paused.store(false, SeqCst);
    }

    pub fn step(&self) {
        self.sh.step_once.store(true, SeqCst);
        self.sh.paused.store(false, SeqCst);
    }
}

fn btn_name(b: &Btn) -> String {
    format!("{b:?}")
}

fn key_name(k: &KeyId) -> String {
    match k {
        KeyId::Char(c) => c.to_uppercase().to_string(),
        KeyId::F(n) => format!("F{n}"),
        other => format!("{other:?}"),
    }
}

/// Stuck-key sweep: release every button and key this run pressed.
fn sweep(sh: &Shared, input: &mut platform::Input) -> (Vec<String>, Vec<String>) {
    let mut h = sh.held.lock().unwrap();
    let buttons: Vec<Btn> = h.buttons.drain(..).collect();
    let keys: Vec<KeyId> = h.keys.drain(..).collect();
    for b in &buttons {
        input.button(*b, false);
    }
    for k in keys.iter().rev() {
        input.key(k, false);
    }
    sh.swept.store(true, SeqCst);
    (buttons.iter().map(btn_name).collect(), keys.iter().map(key_name).collect())
}

fn emit_status(app: &AppHandle, sh: &Shared) {
    let s = sh.status.lock().unwrap().clone();
    let _ = app.emit("run-state", s);
}

fn set_state(app: &AppHandle, sh: &Shared, state: &str, reason: &str) {
    {
        let mut s = sh.status.lock().unwrap();
        if s.state == state && s.reason == reason {
            return;
        }
        s.state = state.into();
        s.reason = reason.into();
    }
    emit_status(app, sh);
}

enum Disp {
    Real(platform::Input),
    Sim { app: AppHandle, at: (i32, i32), last_emit: Instant },
}

impl Disp {
    fn cursor(&self) -> (i32, i32) {
        match self {
            Disp::Real(_) => platform::cursor_pos(),
            Disp::Sim { at, .. } => *at,
        }
    }
    fn move_to(&mut self, x: i32, y: i32) {
        match self {
            Disp::Real(i) => i.move_to(x, y),
            Disp::Sim { app, at, last_emit } => {
                *at = (x, y);
                if last_emit.elapsed() >= Duration::from_millis(15) {
                    *last_emit = Instant::now();
                    let _ = app.emit("ghost", serde_json::json!({ "x": x, "y": y, "click": false }));
                }
            }
        }
    }
    fn button(&mut self, sh: &Shared, b: Btn, down: bool) {
        match self {
            Disp::Real(i) => {
                let mut h = sh.held.lock().unwrap();
                if down {
                    i.button(b, true);
                    h.buttons.push(b);
                } else {
                    i.button(b, false);
                    h.buttons.retain(|x| *x != b);
                    if sh.stop.load(SeqCst) {
                        sh.released.lock().unwrap().0.push(btn_name(&b));
                    }
                }
            }
            Disp::Sim { app, at, .. } => {
                if down {
                    let _ = app.emit("ghost", serde_json::json!({ "x": at.0, "y": at.1, "click": true }));
                }
            }
        }
    }
    fn key(&mut self, sh: &Shared, k: &KeyId, down: bool) {
        if let Disp::Real(i) = self {
            let mut h = sh.held.lock().unwrap();
            i.key(k, down);
            if down {
                h.keys.push(k.clone());
            } else if let Some(p) = h.keys.iter().position(|x| x == k) {
                h.keys.remove(p);
                if sh.stop.load(SeqCst) {
                    sh.released.lock().unwrap().1.push(key_name(k));
                }
            }
        }
    }
    fn scroll(&mut self, dx: i32, dy: i32) {
        if let Disp::Real(i) = self {
            i.scroll(dx, dy);
        }
    }
    fn char(&mut self, c: char) {
        if let Disp::Real(i) = self {
            i.char(c);
        }
    }
}

struct Ctx<'a> {
    app: AppHandle,
    sh: &'a Shared,
    m: &'a Macro,
    d: Disp,
    rng: Rng,
    dry: bool,
    win: WinInfo,
    last_set: Option<(i32, i32)>,
    last_pts: Vec<Option<(f64, f64)>>,
    log: Vec<LogEntry>,
    t0: Instant,
    pass: u32,
    corners: (i32, i32, i32, i32),
    last_poll: Instant,
}

impl<'a> Ctx<'a> {
    /// Checks stop, pause and safety. Blocks while paused.
    fn check(&mut self) -> R<()> {
        loop {
            if self.sh.stop.load(SeqCst) {
                return Err(Halt::Stop);
            }
            if !self.dry && self.last_poll.elapsed() >= Duration::from_millis(15) {
                self.last_poll = Instant::now();
                let (cx, cy) = platform::cursor_pos();
                let (x0, y0, w, h) = self.corners;
                let near = |v: i32, a: i32| (v - a).abs() <= 1;
                if (near(cx, x0) || near(cx, x0 + w - 1)) && (near(cy, y0) || near(cy, y0 + h - 1)) {
                    let mut r = self.sh.stop_req.lock().unwrap();
                    if r.is_none() {
                        *r = Some((Instant::now(), "corner".into(), "The pointer hit a screen corner.".into()));
                    }
                    drop(r);
                    self.sh.stop.store(true, SeqCst);
                    return Err(Halt::Stop);
                }
                if self.m.settings.user_override && !self.sh.paused.load(SeqCst) {
                    if let Some((lx, ly)) = self.last_set {
                        if (cx - lx).abs() + (cy - ly).abs() > 40 {
                            self.sh.paused.store(true, SeqCst);
                            self.last_set = None;
                            set_state(&self.app, self.sh, "paused", "You moved the mouse, so the run paused. Press F5 to resume.");
                            let _ = self.app.emit("cue", "pause");
                        }
                    }
                }
            }
            if !self.sh.paused.load(SeqCst) {
                return Ok(());
            }
            {
                let s = self.sh.status.lock().unwrap();
                if s.state != "paused" {
                    drop(s);
                    set_state(&self.app, self.sh, "paused", "Paused");
                }
            }
            std::thread::sleep(Duration::from_millis(4));
            self.last_set = None;
        }
    }

    /// Sleeps in small slices so stop lands within a few milliseconds.
    fn sleep(&mut self, ms: f64) -> R<()> {
        let end = Instant::now() + Duration::from_secs_f64(ms.max(0.0) / 1000.0);
        loop {
            self.check()?;
            let now = Instant::now();
            if now >= end {
                return Ok(());
            }
            std::thread::sleep((end - now).min(Duration::from_millis(2)));
        }
    }

    fn running_state(&mut self) {
        let st = self.sh.status.lock().unwrap().state.clone();
        if st != "running" {
            set_state(&self.app, self.sh, "running", "");
        }
    }

    /// Resolves the target window and waits while it is missing, minimized
    /// or unfocused. Focus guard: never dispatch into another app.
    fn wait_target(&mut self) -> R<()> {
        let t = &self.m.target;
        loop {
            self.check()?;
            if t.process.is_empty() {
                if self.win.w <= 0 || self.win.h <= 0 {
                    let (vx, vy, vw, vh) = platform::screen_bounds();
                    self.win = WinInfo {
                        id: 0,
                        process: String::new(),
                        title: "Whole screen".into(),
                        x: vx,
                        y: vy,
                        w: vw,
                        h: vh,
                    };
                }
                return Ok(());
            }
            let alive = self.win.id != 0 && platform::window_info(self.win.id).map_or(false, |w| w.process.eq_ignore_ascii_case(&t.process));
            if !alive {
                match platform::find_window(&t.process, &t.title) {
                    Some(w) => self.win = w,
                    None => {
                        if self.dry {
                            self.win = platform::find_window("", "").unwrap_or_default();
                            return Ok(());
                        }
                        set_state(&self.app, self.sh, "waiting", &format!("Waiting for {} to open.", t.process));
                        self.sleep(250.0)?;
                        continue;
                    }
                }
            }
            if let Some(w) = platform::window_info(self.win.id) {
                self.win = w;
            }
            if self.dry {
                return Ok(());
            }
            if platform::is_minimized(self.win.id) {
                set_state(&self.app, self.sh, "waiting", &format!("{} is minimized. The run resumes when you restore it.", t.process));
                self.sleep(200.0)?;
                continue;
            }
            if t.require_focus && !platform::is_foreground(self.win.id) {
                set_state(&self.app, self.sh, "waiting", &format!("Waiting for {} to be in front. Click into it to continue.", t.process));
                self.last_set = None;
                self.sleep(150.0)?;
                continue;
            }
            self.running_state();
            return Ok(());
        }
    }

    fn map(&self, x: f64, y: f64) -> (f64, f64) {
        let (w, h) = if self.win.w > 0 && self.win.h > 0 {
            (self.win.w as f64, self.win.h as f64)
        } else {
            let (_, _, vw, vh) = platform::screen_bounds();
            (vw as f64, vh as f64)
        };
        let (aw, ah) = self.m.authored.map(|a| (a.w, a.h)).filter(|a| a.0 > 0.0 && a.1 > 0.0).unwrap_or((w, h));
        let (px, py) = match self.m.target.on_resize.as_str() {
            "center" => (x + (w - aw) / 2.0, y + (h - ah) / 2.0),
            "top_left" => (x, y),
            _ => (x * w / aw.max(1.0), y * h / ah.max(1.0)),
        };
        (px + self.win.x as f64, py + self.win.y as f64)
    }

    fn set_cursor(&mut self, x: f64, y: f64) {
        let p = (x.round() as i32, y.round() as i32);
        self.d.move_to(p.0, p.1);
        self.last_set = Some(p);
    }

    /// Humanized move to a screen point.
    fn move_to(&mut self, target: (f64, f64), size: f64, speed_mul: f64) -> R<()> {
        self.check()?;
        let s = &self.m.settings;
        let from = self.d.cursor();
        let from = (from.0 as f64, from.1 as f64);
        let dist = ((target.0 - from.0).powi(2) + (target.1 - from.1).powi(2)).sqrt();
        if s.trajectory == "teleport" || dist < 2.0 {
            self.set_cursor(target.0, target.1);
            return Ok(());
        }
        let speed = s.speed.max(0.1) * speed_mul;
        let mut legs = vec![];
        if s.overshoot && dist > 120.0 && self.rng.f() < 0.3 {
            let (ux, uy) = ((target.0 - from.0) / dist, (target.1 - from.1) / dist);
            let o = (dist * self.rng.range(0.04, 0.09)).min(28.0);
            let side = self.rng.range(-0.4, 0.4) * o;
            let over = (target.0 + ux * o - uy * side, target.1 + uy * o + ux * side);
            legs.push((from, over, sampler::move_duration(dist, size, speed)));
            legs.push((over, target, self.rng.range(70.0, 140.0) / speed.sqrt()));
        } else {
            legs.push((from, target, sampler::move_duration(dist, size, speed)));
        }
        for (a, b, dur) in legs {
            let n = ((dur / 7.0) as usize).clamp(4, 220);
            let pts = sampler::bezier_path(&mut self.rng, a, b, s.curvature, n);
            let start = Instant::now();
            for (x, y, t) in pts {
                let due = start + Duration::from_secs_f64(dur * t / 1000.0);
                let now = Instant::now();
                if due > now {
                    self.sleep((due - now).as_secs_f64() * 1000.0)?;
                } else {
                    self.check()?;
                }
                self.set_cursor(x, y);
            }
        }
        self.set_cursor(target.0, target.1);
        Ok(())
    }

    fn zone_point(&mut self, idx: usize, z: &Zone) -> (f64, f64) {
        let p = sampler::sample_zone(&mut self.rng, z, self.last_pts[idx]);
        self.last_pts[idx] = Some(p);
        p
    }

    fn zone_size(z: &Zone) -> f64 {
        let ((x0, y0, x1, y1), _) = sampler::zone_bounds(z);
        (x1 - x0).min(y1 - y0).max(8.0)
    }

    fn press(&mut self, b: Btn, hold: f64) -> R<()> {
        self.check()?;
        self.d.button(self.sh, b, true);
        let r = self.sleep(hold);
        self.d.button(self.sh, b, false);
        r
    }

    fn tap_keys(&mut self, keys: &[KeyId], hold: f64) -> R<()> {
        self.check()?;
        let mut pressed = vec![];
        let mut res = Ok(());
        for (i, k) in keys.iter().enumerate() {
            self.d.key(self.sh, k, true);
            pressed.push(k.clone());
            if i + 1 < keys.len() {
                let gap = self.rng.range(18.0, 45.0);
                if let Err(e) = self.sleep(gap) {
                    res = Err(e);
                    break;
                }
            }
        }
        if res.is_ok() {
            res = self.sleep(hold);
        }
        for k in pressed.iter().rev() {
            self.d.key(self.sh, k, false);
        }
        res
    }

    fn type_char(&mut self, c: char, hold: f64) -> R<()> {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            self.tap_keys(&[KeyId::Char(c)], hold)
        } else if c.is_ascii_uppercase() {
            self.tap_keys(&[KeyId::Shift, KeyId::Char(c)], hold)
        } else if c == ' ' {
            self.tap_keys(&[KeyId::Space], hold)
        } else if c == '\n' {
            self.tap_keys(&[KeyId::Enter], hold)
        } else {
            self.check()?;
            self.d.char(c);
            Ok(())
        }
    }

    /// Wait-until for a pixel guard. Returns true when the colour matched.
    fn guard_wait(&mut self, step: &Step) -> R<bool> {
        let g = match &step.guard {
            Some(g) if !g.samples.is_empty() => g.clone(),
            _ => return Ok(true),
        };
        if self.dry {
            return Ok(true);
        }
        let want = sampler::hex_rgb(&g.hex);
        let timeout = if g.timeout_ms <= 0.0 { 2500.0 } else { g.timeout_ms };
        let start = Instant::now();
        loop {
            let mut hits = 0;
            for s in &g.samples {
                let (x, y) = self.map(s[0], s[1]);
                if let Some(px) = platform::read_pixels(x.round() as i32, y.round() as i32, 1, 1) {
                    if sampler::delta_e(px[0], want) <= g.tolerance {
                        hits += 1;
                    }
                }
            }
            if hits * 2 > g.samples.len() {
                return Ok(true);
            }
            if start.elapsed().as_secs_f64() * 1000.0 >= timeout {
                return Ok(false);
            }
            self.sleep(40.0)?;
        }
    }

    /// Runs one step. Returns a short note for the run log.
    fn exec(&mut self, idx: usize, step: &Step) -> R<(Option<[i32; 2]>, Option<String>, String)> {
        self.wait_target()?;
        let mut guard_note = None;
        if step.guard.as_ref().map_or(false, |g| !g.samples.is_empty()) {
            let g = step.guard.clone().unwrap();
            let mut tries = 0;
            loop {
                if self.guard_wait(step)? {
                    guard_note = Some(if tries == 0 { "matched".into() } else { format!("matched after {tries} retries") });
                    break;
                }
                let _ = self.app.emit("cue", "alert");
                match g.on_timeout.as_str() {
                    "retry" if tries < g.retries => {
                        tries += 1;
                        continue;
                    }
                    "skip" => return Ok((None, Some("timed out, skipped".into()), "Skipped".into())),
                    "halt" => {
                        let mut r = self.sh.stop_req.lock().unwrap();
                        if r.is_none() {
                            *r = Some((
                                Instant::now(),
                                "guard".into(),
                                format!("The colour check on step {} timed out after {} ms.", idx + 1, g.timeout_ms as i64),
                            ));
                        }
                        drop(r);
                        self.sh.stop.store(true, SeqCst);
                        return Err(Halt::Stop);
                    }
                    _ => {
                        self.sh.paused.store(true, SeqCst);
                        set_state(
                            &self.app,
                            self.sh,
                            "paused",
                            &format!("Step {} waited {} ms for {} and gave up. Press F5 to carry on.", idx + 1, g.timeout_ms as i64, g.hex),
                        );
                        self.check()?;
                        self.wait_target()?;
                        guard_note = Some("timed out, resumed by you".into());
                        break;
                    }
                }
            }
        }
        self.wait_target()?;

        let hold = sampler::sample_range(&mut self.rng, &step.hold);
        let mut point = None;
        let goto = |c: &mut Self, z: &Option<Zone>, speed: f64| -> R<Option<[i32; 2]>> {
            if let Some(z) = z {
                let (x, y) = c.zone_point(idx, z);
                let p = c.map(x, y);
                c.move_to(p, Self::zone_size(z), speed)?;
                return Ok(Some([p.0.round() as i32, p.1.round() as i32]));
            }
            Ok(None)
        };
        let note = match &step.action {
            Action::Click { button, count } => {
                point = goto(self, &step.zone, 1.0)?;
                let b = Btn::parse(button);
                for i in 0..(*count).clamp(1, 3) {
                    if i > 0 {
                        let gap = self.rng.range(70.0, 130.0);
                        self.sleep(gap)?;
                    }
                    self.press(b, hold.min(400.0))?;
                }
                format!("{button} click")
            }
            Action::Hold { button } => {
                point = goto(self, &step.zone, 1.0)?;
                self.press(Btn::parse(button), hold)?;
                format!("held {} ms", hold as i64)
            }
            Action::Drag { button, to } => {
                point = goto(self, &step.zone, 1.0)?;
                let b = Btn::parse(button);
                self.check()?;
                self.d.button(self.sh, b, true);
                let r = (|| -> R<()> {
                    let pre = self.rng.range(60.0, 120.0);
                    self.sleep(pre)?;
                    let (x, y) = sampler::sample_zone(&mut self.rng, to, None);
                    let p = self.map(x, y);
                    self.move_to(p, Self::zone_size(to), 0.7)?;
                    let post = self.rng.range(40.0, 90.0);
                    self.sleep(post)
                })();
                self.d.button(self.sh, b, false);
                r?;
                "dragged".into()
            }
            Action::Scroll { amount, horizontal } => {
                point = goto(self, &step.zone, 1.0)?;
                let n = amount.unsigned_abs().max(1);
                let sign = if *amount < 0 { -1 } else { 1 };
                for i in 0..n {
                    if i > 0 {
                        let gap = self.rng.range(35.0, 90.0);
                        self.sleep(gap)?;
                    }
                    self.check()?;
                    if *horizontal {
                        self.d.scroll(sign, 0);
                    } else {
                        self.d.scroll(0, sign);
                    }
                }
                format!("scrolled {amount}")
            }
            Action::Key { keys } => {
                point = goto(self, &step.zone, 1.0)?;
                let ks = KeyId::parse_combo(keys);
                self.tap_keys(&ks, hold.min(2000.0))?;
                format!("pressed {keys}")
            }
            Action::Text { text } => {
                point = goto(self, &step.zone, 1.0)?;
                for c in text.chars() {
                    let h = self.rng.range(25.0, 60.0);
                    self.type_char(c, h)?;
                    let gap = sampler::sample_range(&mut self.rng, &step.hold).min(600.0);
                    self.sleep(gap)?;
                }
                format!("typed {} characters", text.chars().count())
            }
            Action::Move => {
                point = goto(self, &step.zone, 1.0)?;
                "moved".into()
            }
            Action::Wait => "waited".into(),
            Action::Path { points } => {
                if let Some(first) = points.first() {
                    let p = self.map(first[0], first[1]);
                    self.move_to(p, 16.0, 1.0)?;
                    point = Some([p.0.round() as i32, p.1.round() as i32]);
                    let start = Instant::now();
                    let t0 = first[2];
                    let mut buttons = 0u8;
                    let res = (|| -> R<()> {
                        for pt in points {
                            let due = start + Duration::from_secs_f64(((pt[2] - t0) / self.m.settings.speed.max(0.1)).max(0.0) / 1000.0);
                            let now = Instant::now();
                            if due > now {
                                self.sleep((due - now).as_secs_f64() * 1000.0)?;
                            }
                            self.check()?;
                            let (x, y) = self.map(pt[0], pt[1]);
                            self.set_cursor(x, y);
                            let nb = pt[3] as u8;
                            for (bit, b) in [(1u8, Btn::Left), (2, Btn::Right), (4, Btn::Middle)] {
                                if nb & bit != buttons & bit {
                                    self.d.button(self.sh, b, nb & bit != 0);
                                }
                            }
                            buttons = nb;
                        }
                        Ok(())
                    })();
                    for (bit, b) in [(1u8, Btn::Left), (2, Btn::Right), (4, Btn::Middle)] {
                        if buttons & bit != 0 {
                            self.d.button(self.sh, b, false);
                        }
                    }
                    res?;
                }
                format!("replayed {} points", points.len())
            }
        };
        Ok((point, guard_note, note))
    }
}

fn run_thread(app: AppHandle, sh: Arc<Shared>, req: RunRequest) {
    let m = req.mac;
    let started = now_ms();
    let steps: Vec<(usize, Step)> = m.steps.iter().cloned().enumerate().filter(|(_, s)| s.enabled).collect();
    let total = match (req.only || req.dry, m.settings.loop_mode.as_str()) {
        (true, _) => Some(1),
        (_, "count") => Some(m.settings.loop_count.max(1)),
        _ => None,
    };
    {
        let mut s = sh.status.lock().unwrap();
        *s = Status {
            state: "running".into(),
            macro_id: m.id.clone(),
            macro_name: m.name.clone(),
            dry: req.dry,
            pass: 1,
            total_passes: total,
            step: 0,
            step_count: steps.len(),
            step_name: String::new(),
            started,
            step_started: started,
            next_ms: 0.0,
            reason: String::new(),
            process: m.target.process.clone(),
        };
    }
    emit_status(&app, &sh);
    let _ = app.emit("cue", "start");

    let d = if req.dry {
        let c = platform::cursor_pos();
        Disp::Sim { app: app.clone(), at: c, last_emit: Instant::now() }
    } else {
        Disp::Real(platform::Input::new())
    };
    let (vx, vy, vw, vh) = platform::screen_bounds();
    let mut initial_win = WinInfo {
        id: 0,
        process: String::new(),
        title: "Whole screen".into(),
        x: vx,
        y: vy,
        w: vw,
        h: vh,
    };
    if !req.dry && !m.target.process.is_empty() {
        if let Some(w) = platform::find_window(&m.target.process, &m.target.title) {
            platform::focus_window(w.id);
            initial_win = w;
            std::thread::sleep(Duration::from_millis(120));
        }
    }

    let mut ctx = Ctx {
        app: app.clone(),
        sh: &sh,
        m: &m,
        d,
        rng: Rng::new(),
        dry: req.dry,
        win: initial_win,
        last_set: None,
        last_pts: vec![None; m.steps.len()],
        log: vec![],
        t0: Instant::now(),
        pass: 1,
        corners: platform::screen_bounds(),
        last_poll: Instant::now(),
    };

    let first_idx = steps.iter().position(|(i, _)| *i >= req.start).unwrap_or(0);
    let mut next_break = if m.settings.breaks.enabled {
        Some(ctx.rng.int(m.settings.breaks.every_min.max(1), m.settings.breaks.every_max.max(1)))
    } else {
        None
    };
    let mut cur_step = (0usize, String::new());
    let mut pass_ms = 0.0;

    let result: R<()> = (|| {
        loop {
            let pass_start = Instant::now();
            let from = if ctx.pass == 1 { first_idx } else { 0 };
            let list: Vec<(usize, Step)> = if req.only { steps.iter().filter(|(i, _)| *i == req.start).cloned().collect() } else { steps[from..].to_vec() };
            for (n, (idx, step)) in list.iter().enumerate() {
                cur_step = (*idx, step.name.clone());
                let delay = sampler::sample_timing(&mut ctx.rng, &step.delay);
                {
                    let mut s = sh.status.lock().unwrap();
                    s.pass = ctx.pass;
                    s.step = steps.iter().position(|(i, _)| i == idx).unwrap_or(from + n);
                    s.step_name = step.name.clone();
                    s.step_started = now_ms();
                    s.next_ms = delay;
                }
                emit_status(&app, &sh);
                let t = Instant::now();
                let at = ctx.t0.elapsed().as_secs_f64() * 1000.0;
                let (point, guard, note) = ctx.exec(*idx, step)?;
                ctx.sleep(delay)?;
                if ctx.log.len() < 5000 {
                    ctx.log.push(LogEntry {
                        pass: ctx.pass,
                        step: idx + 1,
                        name: step.name.clone(),
                        at_ms: at,
                        dur_ms: t.elapsed().as_secs_f64() * 1000.0,
                        point,
                        guard,
                        note,
                    });
                }
                if sh.step_once.swap(false, SeqCst) {
                    sh.paused.store(true, SeqCst);
                    set_state(&app, &sh, "paused", "Stepped one step. F11 for the next, F5 to run.");
                }
            }
            if ctx.pass == 1 || from == 0 {
                pass_ms = pass_start.elapsed().as_secs_f64() * 1000.0;
            }
            let done = match total {
                Some(t) => ctx.pass >= t,
                None => m.settings.loop_mode == "duration" && ctx.t0.elapsed().as_secs_f64() >= m.settings.duration_min.max(0.1) * 60.0,
            };
            if done {
                return Ok(());
            }
            if let Some(nb) = next_break {
                if ctx.pass >= nb {
                    let b = &m.settings.breaks;
                    let ms = ctx.rng.range(b.pause_min.min(b.pause_max), b.pause_max.max(b.pause_min));
                    set_state(&app, &sh, "break", &format!("Micro-break, {:.1} s", ms / 1000.0));
                    ctx.sleep(ms)?;
                    set_state(&app, &sh, "running", "");
                    next_break = Some(ctx.pass + ctx.rng.int(b.every_min.max(1), b.every_max.max(1)));
                }
            }
            ctx.pass += 1;
        }
    })();

    let mut input_for_sweep = match std::mem::replace(&mut ctx.d, Disp::Real(platform::Input::new())) {
        Disp::Real(i) => i,
        Disp::Sim { .. } => platform::Input::new(),
    };
    let (mut released_buttons, mut released_keys) = sweep(&sh, &mut input_for_sweep);
    {
        let r = sh.released.lock().unwrap();
        released_buttons.extend(r.0.iter().cloned());
        released_keys.extend(r.1.iter().cloned());
    }
    released_buttons.dedup();
    released_keys.dedup();
    let req_info = sh.stop_req.lock().unwrap().clone();
    let (reason, message, latency) = match (&result, req_info) {
        (Err(Halt::Stop), Some((t, reason, msg))) => (reason, msg, Some(t.elapsed().as_secs_f64() * 1000.0)),
        (Err(Halt::Stop), None) => ("stopped".into(), "The run was stopped.".into(), None),
        (Ok(()), _) => ("finished".into(), "The run finished.".into(), None),
    };
    let summary = Summary {
        macro_id: m.id.clone(),
        macro_name: m.name.clone(),
        reason,
        message,
        latency_ms: latency,
        released_buttons,
        released_keys,
        pass: ctx.pass,
        step: cur_step.0 + 1,
        step_name: cur_step.1,
        elapsed_ms: ctx.t0.elapsed().as_secs_f64() * 1000.0,
        dry: req.dry,
        pass_ms,
        started,
        log: std::mem::take(&mut ctx.log),
    };
    drop(ctx);
    {
        let mut s = sh.status.lock().unwrap();
        s.state = "idle".into();
        s.reason.clear();
    }
    emit_status(&app, &sh);
    sh.running.store(false, SeqCst);
    let _ = app.emit("cue", if summary.reason == "finished" { "stop" } else { "alert" });
    crate::store::append_run(&app, &summary);
    let _ = app.emit("run-ended", summary);
}
