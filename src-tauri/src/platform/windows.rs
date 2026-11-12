//! Windows platform layer. The only code that touches Win32 for input,
//! window tracking and screen reads.
//!
//! Input goes through `SendInput` with hardware scan codes so games that
//! read DirectInput / raw keyboard state see real key presses.

use super::{Btn, KeyId, WinInfo};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, SRCCOPY,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

fn hwnd(id: u64) -> HWND {
    id as usize as HWND
}

fn process_name(h: HWND) -> String {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == 0 {
            return String::new();
        }
        let ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if ph.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(ph, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(ph);
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }
}

fn title(h: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

fn info(h: HWND) -> Option<WinInfo> {
    if h.is_null() {
        return None;
    }
    unsafe {
        if IsWindow(h) == 0 {
            return None;
        }
        let mut rc: RECT = zeroed();
        GetClientRect(h, &mut rc);
        let mut p = POINT { x: 0, y: 0 };
        ClientToScreen(h, &mut p);
        Some(WinInfo {
            id: h as usize as u64,
            process: process_name(h),
            title: title(h),
            x: p.x,
            y: p.y,
            w: rc.right - rc.left,
            h: rc.bottom - rc.top,
        })
    }
}

pub fn foreground_window() -> Option<WinInfo> {
    unsafe { info(GetForegroundWindow()) }
}

pub fn window_info(id: u64) -> Option<WinInfo> {
    info(hwnd(id))
}

struct FindCtx {
    process: String,
    title: String,
    best: Option<(i64, HWND)>,
}

unsafe extern "system" fn enum_cb(h: HWND, lp: LPARAM) -> BOOL {
    let ctx = &mut *(lp as *mut FindCtx);
    if IsWindowVisible(h) == 0 || !GetWindow(h, GW_OWNER).is_null() {
        return 1;
    }
    if !process_name(h).eq_ignore_ascii_case(&ctx.process) {
        return 1;
    }
    if !ctx.title.is_empty() && !title(h).to_lowercase().contains(&ctx.title.to_lowercase()) {
        return 1;
    }
    let mut rc: RECT = zeroed();
    GetClientRect(h, &mut rc);
    let mut area = (rc.right - rc.left) as i64 * (rc.bottom - rc.top) as i64;
    if IsIconic(h) != 0 {
        area = 0; // still a match, but prefer restored windows
    }
    if ctx.best.map_or(true, |(a, _)| area > a) {
        ctx.best = Some((area, h));
    }
    1
}

/// Match by process name first, title second, so a title change mid-session
/// does not break a run.
pub fn find_window(process: &str, title_match: &str) -> Option<WinInfo> {
    let mut ctx = FindCtx { process: process.to_string(), title: title_match.to_string(), best: None };
    unsafe {
        EnumWindows(Some(enum_cb), &mut ctx as *mut FindCtx as LPARAM);
    }
    if ctx.best.is_none() && !title_match.is_empty() {
        return find_window(process, "");
    }
    ctx.best.and_then(|(_, h)| info(h))
}

pub fn is_foreground(id: u64) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg == hwnd(id) {
            return true;
        }
        // A game can own a child or popup that takes focus; same process counts.
        let mut a = 0u32;
        let mut b = 0u32;
        GetWindowThreadProcessId(fg, &mut a);
        GetWindowThreadProcessId(hwnd(id), &mut b);
        a != 0 && a == b
    }
}

pub fn is_minimized(id: u64) -> bool {
    unsafe { IsIconic(hwnd(id)) != 0 }
}

pub fn focus_window(id: u64) -> bool {
    unsafe {
        let h = hwnd(id);
        if IsIconic(h) != 0 {
            ShowWindow(h, SW_RESTORE);
        }
        if SetForegroundWindow(h) != 0 {
            return true;
        }
        // Foreground lock workaround: a synthetic Alt tap lets this process
        // hand focus over to another window.
        let mut i = Input::new();
        i.vk(VK_MENU, false);
        i.vk(VK_MENU, true);
        SetForegroundWindow(h) != 0
    }
}

pub fn cursor_pos() -> (i32, i32) {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        GetCursorPos(&mut p);
        (p.x, p.y)
    }
}

/// Virtual screen bounds (all monitors), in physical pixels.
pub fn screen_bounds() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
        )
    }
}

/// Bitmask of physical mouse buttons currently down: 1 left, 2 right, 4 middle.
pub fn button_state() -> u8 {
    unsafe {
        let mut s = 0u8;
        if GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000 != 0 {
            s |= 1;
        }
        if GetAsyncKeyState(VK_RBUTTON as i32) as u16 & 0x8000 != 0 {
            s |= 2;
        }
        if GetAsyncKeyState(VK_MBUTTON as i32) as u16 & 0x8000 != 0 {
            s |= 4;
        }
        s
    }
}

/// Reads a block of screen pixels as RGB. Layered (overlay) windows are not
/// included because CAPTUREBLT is not set.
pub fn read_pixels(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<[u8; 3]>> {
    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let sdc = GetDC(std::ptr::null_mut());
        if sdc.is_null() {
            return None;
        }
        let mdc = CreateCompatibleDC(sdc);
        let bmp = CreateCompatibleBitmap(sdc, w, h);
        let old = SelectObject(mdc, bmp as _);
        let ok = BitBlt(mdc, 0, 0, w, h, sdc, x, y, SRCCOPY) != 0;
        let mut out = None;
        if ok {
            let mut bi: BITMAPINFO = zeroed();
            bi.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..zeroed()
            };
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(mdc, bmp, 0, h as u32, buf.as_mut_ptr() as *mut c_void, &mut bi, DIB_RGB_COLORS);
            if lines > 0 {
                out = Some(buf.chunks_exact(4).map(|p| [p[2], p[1], p[0]]).collect());
            }
        }
        SelectObject(mdc, old);
        DeleteObject(bmp as _);
        DeleteDC(mdc);
        ReleaseDC(std::ptr::null_mut(), sdc);
        out
    }
}

/// Keep the overlay out of screenshots, recordings and our own pixel reads,
/// and stop it from ever taking activation from the game.
pub fn prepare_overlay(id: u64) {
    unsafe {
        let h = hwnd(id);
        SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        SetWindowLongPtrW(h, GWL_EXSTYLE, ex | (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as isize);
    }
}

/// Show without activating, and push to the top of the topmost band so a
/// borderless fullscreen game stays focused underneath.
pub fn show_no_activate(id: u64, interactive: bool) {
    unsafe {
        let h = hwnd(id);
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        let ex = if interactive { ex & !(WS_EX_NOACTIVATE as isize) } else { ex | WS_EX_NOACTIVATE as isize };
        SetWindowLongPtrW(h, GWL_EXSTYLE, ex);
        ShowWindow(h, if interactive { SW_SHOW } else { SW_SHOWNOACTIVATE });
        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        if interactive {
            SetForegroundWindow(h);
        }
    }
}

// ---------------------------------------------------------------- input

pub struct Input;

impl Input {
    pub fn new() -> Self {
        Input
    }

    fn send(inputs: &[INPUT]) {
        unsafe {
            SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32);
        }
    }

    fn mouse(flags: u32, dx: i32, dy: i32, data: i32) -> INPUT {
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_MOUSE;
        i.Anonymous.mi = MOUSEINPUT { dx, dy, mouseData: data as _, dwFlags: flags, time: 0, dwExtraInfo: 0 };
        i
    }

    fn vk(&mut self, vk: u16, up: bool) {
        let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
        let extended = matches!(
            vk,
            VK_UP | VK_DOWN | VK_LEFT | VK_RIGHT | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_INSERT
                | VK_DELETE | VK_RCONTROL | VK_RMENU | VK_LWIN | VK_RWIN | VK_DIVIDE | VK_NUMLOCK
        );
        let mut flags = if scan != 0 { KEYEVENTF_SCANCODE } else { 0 };
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_KEYBOARD;
        i.Anonymous.ki = KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 };
        Self::send(&[i]);
    }

    pub fn move_to(&mut self, x: i32, y: i32) {
        let (vx, vy, vw, vh) = screen_bounds();
        let nx = (((x - vx) as i64 * 65535) / (vw - 1).max(1) as i64) as i32;
        let ny = (((y - vy) as i64 * 65535) / (vh - 1).max(1) as i64) as i32;
        Self::send(&[Self::mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0)]);
    }

    pub fn button(&mut self, b: Btn, down: bool) {
        let (flag, data) = match (b, down) {
            (Btn::Left, true) => (MOUSEEVENTF_LEFTDOWN, 0),
            (Btn::Left, false) => (MOUSEEVENTF_LEFTUP, 0),
            (Btn::Right, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
            (Btn::Right, false) => (MOUSEEVENTF_RIGHTUP, 0),
            (Btn::Middle, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
            (Btn::Middle, false) => (MOUSEEVENTF_MIDDLEUP, 0),
            (Btn::X1, true) => (MOUSEEVENTF_XDOWN, 1),
            (Btn::X1, false) => (MOUSEEVENTF_XUP, 1),
            (Btn::X2, true) => (MOUSEEVENTF_XDOWN, 2),
            (Btn::X2, false) => (MOUSEEVENTF_XUP, 2),
        };
        Self::send(&[Self::mouse(flag, 0, 0, data)]);
    }

    pub fn scroll(&mut self, dx: i32, dy: i32) {
        if dy != 0 {
            Self::send(&[Self::mouse(MOUSEEVENTF_WHEEL, 0, 0, dy * 120)]);
        }
        if dx != 0 {
            Self::send(&[Self::mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx * 120)]);
        }
    }

    pub fn key(&mut self, k: &KeyId, down: bool) {
        if let Some(vk) = vk_of(k) {
            self.vk(vk, !down);
        } else if let KeyId::Char(c) = k {
            if down {
                self.char(*c);
            }
        }
    }

    /// Unicode text injection for characters with no key on this layout.
    pub fn char(&mut self, c: char) {
        let mut buf = [0u16; 2];
        for unit in c.encode_utf16(&mut buf).iter() {
            let mut a: INPUT = unsafe { zeroed() };
            a.r#type = INPUT_KEYBOARD;
            a.Anonymous.ki = KEYBDINPUT { wVk: 0, wScan: *unit, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 };
            let mut b = a;
            b.Anonymous.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            Self::send(&[a, b]);
        }
    }
}

fn vk_of(k: &KeyId) -> Option<u16> {
    Some(match k {
        KeyId::Ctrl => VK_LCONTROL,
        KeyId::Shift => VK_LSHIFT,
        KeyId::Alt => VK_LMENU,
        KeyId::Meta => VK_LWIN,
        KeyId::F(n) => VK_F1 + (*n as u16 - 1),
        KeyId::Enter => VK_RETURN,
        KeyId::Space => VK_SPACE,
        KeyId::Tab => VK_TAB,
        KeyId::Esc => VK_ESCAPE,
        KeyId::Backspace => VK_BACK,
        KeyId::Delete => VK_DELETE,
        KeyId::Insert => VK_INSERT,
        KeyId::Up => VK_UP,
        KeyId::Down => VK_DOWN,
        KeyId::Left => VK_LEFT,
        KeyId::Right => VK_RIGHT,
        KeyId::Home => VK_HOME,
        KeyId::End => VK_END,
        KeyId::PageUp => VK_PRIOR,
        KeyId::PageDown => VK_NEXT,
        KeyId::Char(c) => {
            let c = c.to_ascii_uppercase();
            if c.is_ascii_alphanumeric() {
                c as u16
            } else {
                let r = unsafe { VkKeyScanW(c as u16) };
                if r == -1 || (r as u16 & 0xff00) != 0 {
                    return None; // needs a modifier: fall back to unicode injection
                }
                r as u16 & 0xff
            }
        }
    })
}

unsafe extern "system" fn list_cb(h: HWND, lp: LPARAM) -> BOOL {
    let out = &mut *(lp as *mut Vec<WinInfo>);
    if IsWindowVisible(h) == 0 || !GetWindow(h, GW_OWNER).is_null() {
        return 1;
    }
    let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    if ex & WS_EX_TOOLWINDOW as isize != 0 {
        return 1;
    }
    if let Some(w) = info(h) {
        if !w.title.is_empty() && w.w >= 120 && w.h >= 80 && w.process.to_lowercase() != own_exe() {
            out.push(w);
        }
    }
    1
}

fn own_exe() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

/// Visible top-level windows of other apps, for the window picker.
pub fn list_windows() -> Vec<WinInfo> {
    let mut out: Vec<WinInfo> = vec![];
    unsafe {
        EnumWindows(Some(list_cb), &mut out as *mut Vec<WinInfo> as LPARAM);
    }
    out
}

/// True when the window belongs to this app (main window or overlay).
pub fn is_own(w: &WinInfo) -> bool {
    w.process.to_lowercase() == own_exe()
}
