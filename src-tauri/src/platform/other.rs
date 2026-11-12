//! macOS and Linux (X11) platform layer. Input goes through enigo. Window
//! tracking is not available here, so the "window" is the main display and
//! coordinates are screen-relative.

use super::{Btn, KeyId, WinInfo};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::cell::RefCell;

thread_local! {
    static PROBE: RefCell<Option<Enigo>> = const { RefCell::new(None) };
}

fn with_probe<R>(f: impl FnOnce(&Enigo) -> R) -> Option<R> {
    PROBE.with(|p| {
        let mut p = p.borrow_mut();
        if p.is_none() {
            *p = Enigo::new(&Settings::default()).ok();
        }
        p.as_ref().map(f)
    })
}

fn screen() -> WinInfo {
    let (w, h) = with_probe(|e| e.main_display().unwrap_or((1920, 1080))).unwrap_or((1920, 1080));
    WinInfo { id: 0, process: String::new(), title: "Screen".into(), x: 0, y: 0, w, h }
}

pub fn foreground_window() -> Option<WinInfo> {
    Some(screen())
}

pub fn window_info(_id: u64) -> Option<WinInfo> {
    Some(screen())
}

pub fn find_window(_process: &str, _title: &str) -> Option<WinInfo> {
    Some(screen())
}

pub fn is_foreground(_id: u64) -> bool {
    true
}

pub fn is_minimized(_id: u64) -> bool {
    false
}

pub fn focus_window(_id: u64) -> bool {
    true
}

pub fn cursor_pos() -> (i32, i32) {
    with_probe(|e| e.location().unwrap_or((0, 0))).unwrap_or((0, 0))
}

pub fn screen_bounds() -> (i32, i32, i32, i32) {
    let s = screen();
    (0, 0, s.w.max(1), s.h.max(1))
}

pub fn button_state() -> u8 {
    0
}

pub fn prepare_overlay(_id: u64) {}

pub fn show_no_activate(_id: u64, _interactive: bool) {}

#[cfg(target_os = "macos")]
pub fn read_pixels(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<[u8; 3]>> {
    use core_graphics::display::CGDisplay;
    use core_graphics::window::{kCGNullWindowID, kCGWindowImageDefault, kCGWindowListOptionOnScreenOnly};
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    if w <= 0 || h <= 0 {
        return None;
    }
    let rect = CGRect::new(&CGPoint::new(x as f64, y as f64), &CGSize::new(w as f64, h as f64));
    let img = CGDisplay::screenshot(rect, kCGWindowListOptionOnScreenOnly, kCGNullWindowID, kCGWindowImageDefault)?;
    let iw = img.width() as usize;
    let ih = img.height() as usize;
    let bpr = img.bytes_per_row();
    let bpp = img.bits_per_pixel() / 8;
    if iw == 0 || ih == 0 || bpp < 3 {
        return None;
    }
    let data = img.data();
    let bytes = data.bytes();
    let mut out = Vec::with_capacity((w * h) as usize);
    for row in 0..h as usize {
        for col in 0..w as usize {
            // Retina images are larger than the point rect: scale the index.
            let sx = (col * iw / w as usize).min(iw - 1);
            let sy = (row * ih / h as usize).min(ih - 1);
            let i = sy * bpr + sx * bpp;
            if i + 2 >= bytes.len() {
                out.push([0, 0, 0]);
            } else {
                out.push([bytes[i + 2], bytes[i + 1], bytes[i]]); // BGRA
            }
        }
    }
    Some(out)
}

#[cfg(target_os = "linux")]
pub fn read_pixels(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<[u8; 3]>> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, ImageFormat};
    if w <= 0 || h <= 0 {
        return None;
    }
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, root, x as i16, y as i16, w as u16, h as u16, !0)
        .ok()?
        .reply()
        .ok()?;
    let d = reply.data;
    if d.len() < (w * h * 4) as usize {
        return None;
    }
    Some(d.chunks_exact(4).take((w * h) as usize).map(|p| [p[2], p[1], p[0]]).collect())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn read_pixels(_x: i32, _y: i32, _w: i32, _h: i32) -> Option<Vec<[u8; 3]>> {
    None
}

pub struct Input {
    e: Option<Enigo>,
}

impl Input {
    pub fn new() -> Self {
        let settings = Settings { release_keys_when_dropped: true, ..Settings::default() };
        Input { e: Enigo::new(&settings).ok() }
    }

    pub fn move_to(&mut self, x: i32, y: i32) {
        if let Some(e) = self.e.as_mut() {
            let _ = e.move_mouse(x, y, Coordinate::Abs);
        }
    }

    pub fn button(&mut self, b: Btn, down: bool) {
        let b = match b {
            Btn::Left => Button::Left,
            Btn::Right => Button::Right,
            Btn::Middle => Button::Middle,
            Btn::X1 => Button::Back,
            Btn::X2 => Button::Forward,
        };
        if let Some(e) = self.e.as_mut() {
            let _ = e.button(b, if down { Direction::Press } else { Direction::Release });
        }
    }

    pub fn scroll(&mut self, dx: i32, dy: i32) {
        if let Some(e) = self.e.as_mut() {
            // Positive wheel delta means "away from the user" on Windows; enigo
            // uses positive = down, so flip to keep profiles portable.
            if dy != 0 {
                let _ = e.scroll(-dy, Axis::Vertical);
            }
            if dx != 0 {
                let _ = e.scroll(dx, Axis::Horizontal);
            }
        }
    }

    pub fn key(&mut self, k: &KeyId, down: bool) {
        let key = match k {
            KeyId::Ctrl => Key::Control,
            KeyId::Shift => Key::Shift,
            KeyId::Alt => Key::Alt,
            KeyId::Meta => Key::Meta,
            KeyId::F(n) => match n {
                1 => Key::F1,
                2 => Key::F2,
                3 => Key::F3,
                4 => Key::F4,
                5 => Key::F5,
                6 => Key::F6,
                7 => Key::F7,
                8 => Key::F8,
                9 => Key::F9,
                10 => Key::F10,
                11 => Key::F11,
                _ => Key::F12,
            },
            KeyId::Enter => Key::Return,
            KeyId::Space => Key::Space,
            KeyId::Tab => Key::Tab,
            KeyId::Esc => Key::Escape,
            KeyId::Backspace => Key::Backspace,
            KeyId::Delete => Key::Delete,
            #[cfg(not(target_os = "macos"))]
            KeyId::Insert => Key::Insert,
            #[cfg(target_os = "macos")]
            KeyId::Insert => return,
            KeyId::Up => Key::UpArrow,
            KeyId::Down => Key::DownArrow,
            KeyId::Left => Key::LeftArrow,
            KeyId::Right => Key::RightArrow,
            KeyId::Home => Key::Home,
            KeyId::End => Key::End,
            KeyId::PageUp => Key::PageUp,
            KeyId::PageDown => Key::PageDown,
            KeyId::Char(c) => Key::Unicode(c.to_ascii_lowercase()),
        };
        if let Some(e) = self.e.as_mut() {
            let _ = e.key(key, if down { Direction::Press } else { Direction::Release });
        }
    }

    pub fn char(&mut self, c: char) {
        if let Some(e) = self.e.as_mut() {
            let _ = e.text(&c.to_string());
        }
    }
}

pub fn list_windows() -> Vec<WinInfo> {
    vec![screen()]
}

pub fn is_own(_w: &WinInfo) -> bool {
    false
}
