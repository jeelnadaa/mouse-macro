//! Profile schema v2. No UI or OS dependencies. Every field has a default so
//! older or hand-edited files still load.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Macro {
    pub id: String,
    pub name: String,
    pub version: String,
    pub created: i64,
    pub updated: i64,
    pub last_run: Option<i64>,
    /// File the user saved this macro to with Save as, if any.
    pub file: String,
    pub authored: Option<Size>,
    pub target: Target,
    pub settings: RunSettings,
    pub steps: Vec<Step>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Target {
    /// Executable name, e.g. "VALORANT-Win64-Shipping.exe". Empty means the whole screen.
    pub process: String,
    pub title: String,
    pub require_focus: bool,
    /// "scale" | "top_left" | "center"
    pub on_resize: String,
}

impl Default for Target {
    fn default() -> Self {
        Target { process: String::new(), title: String::new(), require_focus: true, on_resize: "scale".into() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct RunSettings {
    /// "infinite" | "count" | "duration"
    pub loop_mode: String,
    pub loop_count: u32,
    pub duration_min: f64,
    pub breaks: Breaks,
    /// "bezier" | "teleport"
    pub trajectory: String,
    /// 1.0 = natural hand speed; 2.0 = twice as fast.
    pub speed: f64,
    pub overshoot: bool,
    /// 0..1, how far a path may bow away from the straight line.
    pub curvature: f64,
    /// Pause when the real mouse moves during a run.
    pub user_override: bool,
}

impl Default for RunSettings {
    fn default() -> Self {
        RunSettings {
            loop_mode: "infinite".into(),
            loop_count: 10,
            duration_min: 30.0,
            breaks: Breaks::default(),
            trajectory: "bezier".into(),
            speed: 1.0,
            overshoot: true,
            curvature: 0.25,
            user_override: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Breaks {
    pub enabled: bool,
    pub every_min: u32,
    pub every_max: u32,
    pub pause_min: f64,
    pub pause_max: f64,
}

impl Default for Breaks {
    fn default() -> Self {
        Breaks { enabled: false, every_min: 8, every_max: 15, pause_min: 2000.0, pause_max: 6000.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Step {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub action: Action,
    pub zone: Option<Zone>,
    pub hold: Range,
    pub delay: Timing,
    pub guard: Option<Guard>,
}

impl Default for Step {
    fn default() -> Self {
        Step {
            id: String::new(),
            enabled: true,
            name: "Step".into(),
            action: Action::Click { button: "left".into(), count: 1 },
            zone: None,
            hold: Range { min: 45.0, max: 80.0 },
            delay: Timing::default(),
            guard: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Action {
    Click {
        #[serde(default = "left")]
        button: String,
        #[serde(default = "one")]
        count: u32,
    },
    Hold {
        #[serde(default = "left")]
        button: String,
    },
    Drag {
        #[serde(default = "left")]
        button: String,
        to: Zone,
    },
    Scroll {
        #[serde(default)]
        amount: i32,
        #[serde(default)]
        horizontal: bool,
    },
    Key {
        #[serde(default)]
        keys: String,
    },
    Text {
        #[serde(default)]
        text: String,
    },
    Move,
    Wait,
    /// A recorded path: [x, y, t_ms, buttons] in client coordinates.
    Path {
        #[serde(default)]
        points: Vec<[f64; 4]>,
    },
}

fn left() -> String {
    "left".into()
}
fn one() -> u32 {
    1
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Zone {
    /// "point" | "circle" | "rect" | "poly"
    pub shape: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub r: f64,
    pub points: Vec<[f64; 2]>,
    /// "gaussian" | "uniform"
    pub dist: String,
    pub pad: f64,
    pub anti_repeat: f64,
}

impl Default for Zone {
    fn default() -> Self {
        Zone {
            shape: "point".into(),
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
            r: 0.0,
            points: vec![],
            dist: "gaussian".into(),
            pad: 2.0,
            anti_repeat: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Range {
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Timing {
    /// "fixed" | "uniform" | "gaussian"
    pub dist: String,
    pub mean: f64,
    pub spread: f64,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { dist: "gaussian".into(), mean: 600.0, spread: 80.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Guard {
    /// Sample points in client coordinates. Majority wins when there are several.
    pub samples: Vec<[f64; 2]>,
    pub hex: String,
    /// ΔE (CIE76) tolerance, 0..100.
    pub tolerance: f64,
    pub timeout_ms: f64,
    /// "retry" | "skip" | "pause" | "halt"
    pub on_timeout: String,
    pub retries: u32,
}

impl Default for Guard {
    fn default() -> Self {
        Guard {
            samples: vec![],
            hex: "#000000".into(),
            tolerance: 12.0,
            timeout_ms: 2500.0,
            on_timeout: "retry".into(),
            retries: 3,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_macro_serialization_and_defaults() {
        let json_str = r#"{
            "id": "m-test",
            "name": "Valorant Buy",
            "target": { "process": "VALORANT.exe", "title": "VALORANT" },
            "steps": [
                {
                    "name": "Click Phantom",
                    "action": { "kind": "click", "button": "left", "count": 1 },
                    "zone": { "shape": "rect", "x": 100.0, "y": 200.0, "w": 50.0, "h": 30.0 },
                    "delay": { "mean": 450.0, "spread": 20.0 }
                },
                {
                    "name": "Click Shields",
                    "action": { "kind": "click", "button": "left", "count": 1 },
                    "zone": { "shape": "point", "x": 350.0, "y": 600.0 },
                    "delay": { "mean": 1200.0, "spread": 100.0 }
                }
            ]
        }"#;

        let mac: Macro = serde_json::from_str(json_str).expect("Failed to deserialize test macro");
        assert_eq!(mac.id, "m-test");
        assert_eq!(mac.name, "Valorant Buy");
        assert_eq!(mac.target.process, "VALORANT.exe");
        assert_eq!(mac.steps.len(), 2);
        assert_eq!(mac.steps[0].zone.as_ref().unwrap().shape, "rect");
        assert_eq!(mac.steps[0].delay.mean, 450.0);
        assert_eq!(mac.steps[1].zone.as_ref().unwrap().shape, "point");
        assert_eq!(mac.steps[1].delay.mean, 1200.0);

        let serialized = serde_json::to_string(&mac).expect("Failed to serialize");
        let roundtrip: Macro = serde_json::from_str(&serialized).expect("Failed roundtrip");
        assert_eq!(roundtrip.name, mac.name);
    }
}
