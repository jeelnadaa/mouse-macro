//! Library storage: one JSON file per macro plus a small index. Writes are
//! atomic (temp file + rename) and a corrupt macro never blocks the others.

use crate::model::Macro;
use crate::runner::Summary;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Cache {
    written: Mutex<HashMap<String, String>>,
}

#[derive(Serialize)]
pub struct Library {
    pub macros: Vec<Macro>,
    pub index: Value,
    pub broken: Vec<String>,
    pub dir: String,
}

pub fn root(app: &AppHandle) -> PathBuf {
    let d = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(d.join("macros"));
    d
}

fn safe_id(id: &str) -> String {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    if s.is_empty() { "macro".into() } else { s }
}

fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Could not save {}: {e}", path.display()))
}

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

pub fn load_library(app: &AppHandle, cache: &Cache) -> Library {
    let dir = root(app);
    let mdir = dir.join("macros");
    let mut macros = vec![];
    let mut broken = vec![];
    let mut written = cache.written.lock().unwrap();
    if let Ok(rd) = fs::read_dir(&mdir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let text = fs::read_to_string(&p).unwrap_or_default();
            match serde_json::from_str::<Macro>(&text) {
                Ok(mut m) if !m.id.is_empty() => {
                    m.id = safe_id(&m.id);
                    written.insert(m.id.clone(), text);
                    macros.push(m);
                }
                _ => {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("macro").to_string();
                    let bdir = mdir.join("needs-repair");
                    let _ = fs::create_dir_all(&bdir);
                    let _ = fs::rename(&p, bdir.join(format!("{}-{}", crate::runner::now_ms(), name)));
                    broken.push(name);
                }
            }
        }
    }
    Library { macros, index: read_json(&dir.join("index.json")), broken, dir: dir.display().to_string() }
}

/// Writes only macros whose content changed and removes files for macros
/// that no longer exist.
pub fn save_library(app: &AppHandle, cache: &Cache, macros: &[Macro], index: &Value) -> Result<(), String> {
    let dir = root(app);
    let mdir = dir.join("macros");
    let mut written = cache.written.lock().unwrap();
    let mut keep = std::collections::HashSet::new();
    for m in macros {
        let id = safe_id(&m.id);
        keep.insert(id.clone());
        let text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
        if written.get(&id) != Some(&text) {
            write_atomic(&mdir.join(format!("{id}.json")), &text)?;
            written.insert(id, text);
        }
    }
    let gone: Vec<String> = written.keys().filter(|k| !keep.contains(*k)).cloned().collect();
    for id in gone {
        let _ = fs::remove_file(mdir.join(format!("{id}.json")));
        written.remove(&id);
    }
    write_atomic(&dir.join("index.json"), &serde_json::to_string_pretty(index).map_err(|e| e.to_string())?)
}

pub fn load_prefs(app: &AppHandle) -> Value {
    read_json(&root(app).join("prefs.json"))
}

pub fn save_prefs(app: &AppHandle, prefs: &Value) -> Result<(), String> {
    write_atomic(&root(app).join("prefs.json"), &serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?)
}

pub fn load_runs(app: &AppHandle) -> Value {
    match read_json(&root(app).join("runs.json")) {
        Value::Array(a) => Value::Array(a),
        _ => Value::Array(vec![]),
    }
}

/// Keeps the last 30 runs. The run log survives crashes of the target app.
pub fn append_run(app: &AppHandle, s: &Summary) {
    let path = root(app).join("runs.json");
    let mut runs = match read_json(&path) {
        Value::Array(a) => a,
        _ => vec![],
    };
    if let Ok(v) = serde_json::to_value(s) {
        runs.insert(0, v);
    }
    runs.truncate(30);
    if let Ok(t) = serde_json::to_string(&runs) {
        let _ = write_atomic(&path, &t);
    }
}

pub fn clear_runs(app: &AppHandle) {
    let _ = fs::remove_file(root(app).join("runs.json"));
}

/// Default folder for Save as: Documents/AetherMacro.
pub fn default_save_dir(app: &AppHandle) -> PathBuf {
    let base = app.path().document_dir().or_else(|_| app.path().home_dir()).unwrap_or_else(|_| PathBuf::from("."));
    let d = base.join("AetherMacro");
    let _ = fs::create_dir_all(&d);
    d
}

/// Saves an export into the Downloads folder and returns its path.
pub fn export(app: &AppHandle, file_name: &str, content: &str) -> Result<String, String> {
    let dir = app.path().download_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
    let clean: String = file_name.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '_' }).collect();
    let mut path = dir.join(&clean);
    let mut n = 1;
    while path.exists() {
        let stem = Path::new(&clean).file_stem().and_then(|s| s.to_str()).unwrap_or("export");
        path = dir.join(format!("{stem} ({n}).json"));
        n += 1;
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}
