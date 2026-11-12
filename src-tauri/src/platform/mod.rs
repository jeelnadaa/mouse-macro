//! Platform layer: the only module that talks to the OS for input, window
//! tracking and screen reads. Coordinates are "native screen units": physical
//! pixels on Windows and X11, points on macOS.

use serde::Serialize;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use self::other::*;

#[derive(Clone, Debug, Serialize, Default)]
pub struct WinInfo {
    pub id: u64,
    pub process: String,
    pub title: String,
    /// Client area origin and size, in native screen units.
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Btn {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

impl Btn {
    pub fn parse(s: &str) -> Btn {
        match s {
            "right" => Btn::Right,
            "middle" => Btn::Middle,
            "x1" => Btn::X1,
            "x2" => Btn::X2,
            _ => Btn::Left,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyId {
    Ctrl,
    Shift,
    Alt,
    Meta,
    F(u8),
    Enter,
    Space,
    Tab,
    Esc,
    Backspace,
    Delete,
    Insert,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Char(char),
}

impl KeyId {
    pub fn parse(tok: &str) -> Option<KeyId> {
        let t = tok.trim();
        if t.is_empty() {
            return None;
        }
        let u = t.to_ascii_lowercase();
        Some(match u.as_str() {
            "ctrl" | "control" => KeyId::Ctrl,
            "shift" => KeyId::Shift,
            "alt" | "option" => KeyId::Alt,
            "meta" | "win" | "cmd" | "super" | "command" => KeyId::Meta,
            "enter" | "return" => KeyId::Enter,
            "space" | "spacebar" => KeyId::Space,
            "tab" => KeyId::Tab,
            "esc" | "escape" => KeyId::Esc,
            "backspace" => KeyId::Backspace,
            "delete" | "del" => KeyId::Delete,
            "insert" | "ins" => KeyId::Insert,
            "up" | "arrowup" => KeyId::Up,
            "down" | "arrowdown" => KeyId::Down,
            "left" | "arrowleft" => KeyId::Left,
            "right" | "arrowright" => KeyId::Right,
            "home" => KeyId::Home,
            "end" => KeyId::End,
            "pageup" | "pgup" => KeyId::PageUp,
            "pagedown" | "pgdn" => KeyId::PageDown,
            _ => {
                if let Some(n) = u.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                    if (1..=24).contains(&n) {
                        return Some(KeyId::F(n));
                    }
                }
                let mut cs = t.chars();
                let c = cs.next()?;
                if cs.next().is_some() {
                    return None;
                }
                KeyId::Char(c)
            }
        })
    }

    /// "Ctrl+Shift+E" -> [Ctrl, Shift, Char('E')]. A literal "+" key is written "Plus".
    pub fn parse_combo(s: &str) -> Vec<KeyId> {
        s.split('+')
            .filter_map(|t| if t.trim().eq_ignore_ascii_case("plus") { Some(KeyId::Char('+')) } else { KeyId::parse(t) })
            .collect()
    }
}
