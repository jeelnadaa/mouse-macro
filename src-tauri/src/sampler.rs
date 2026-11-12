//! Geometry sampler, timing distributions and trajectories. Pure math, no OS.

use crate::model::{Range, Timing, Zone};
use std::time::{SystemTime, UNIX_EPOCH};

/// Small, fast xorshift RNG. Good enough for humanization, no dependency.
pub struct Rng(u64);

impl Rng {
    pub fn new() -> Self {
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9E3779B97F4A7C15);
        Rng(seed | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    pub fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, a: f64, b: f64) -> f64 {
        if b <= a {
            return a;
        }
        a + (b - a) * self.f()
    }
    pub fn int(&mut self, a: u32, b: u32) -> u32 {
        if b <= a {
            return a;
        }
        a + (self.next_u64() % (b - a + 1) as u64) as u32
    }
    /// Standard normal (Box-Muller).
    pub fn gauss(&mut self) -> f64 {
        let u = 1.0 - self.f();
        let v = self.f();
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

pub fn sample_range(rng: &mut Rng, r: &Range) -> f64 {
    let (a, b) = if r.min <= r.max { (r.min, r.max) } else { (r.max, r.min) };
    rng.range(a, b).max(0.0)
}

/// Gaussian timing is clamped at ±2σ so a delay can never run away.
pub fn sample_timing(rng: &mut Rng, t: &Timing) -> f64 {
    let v = match t.dist.as_str() {
        "fixed" => t.mean,
        "uniform" => rng.range(t.mean - t.spread, t.mean + t.spread),
        _ => t.mean + (rng.gauss() * t.spread).clamp(-2.0 * t.spread, 2.0 * t.spread),
    };
    v.max(0.0)
}

pub fn point_in_poly(p: &[[f64; 2]], x: f64, y: f64) -> bool {
    let mut inside = false;
    let n = p.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (p[i][0], p[i][1]);
        let (xj, yj) = (p[j][0], p[j][1]);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn seg_dist(px: f64, py: f64, a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 == 0.0 { 0.0 } else { (((px - a[0]) * dx + (py - a[1]) * dy) / l2).clamp(0.0, 1.0) };
    ((px - a[0] - t * dx).powi(2) + (py - a[1] - t * dy).powi(2)).sqrt()
}

fn poly_edge_dist(p: &[[f64; 2]], x: f64, y: f64) -> f64 {
    let n = p.len();
    (0..n).map(|i| seg_dist(x, y, p[i], p[(i + 1) % n])).fold(f64::MAX, f64::min)
}

/// Bounding box (x0, y0, x1, y1) and centroid of a zone.
pub fn zone_bounds(z: &Zone) -> ((f64, f64, f64, f64), (f64, f64)) {
    match z.shape.as_str() {
        "circle" => ((z.x - z.r, z.y - z.r, z.x + z.r, z.y + z.r), (z.x, z.y)),
        "rect" => ((z.x, z.y, z.x + z.w, z.y + z.h), (z.x + z.w / 2.0, z.y + z.h / 2.0)),
        "poly" if z.points.len() >= 3 => {
            let xs = z.points.iter().map(|p| p[0]);
            let ys = z.points.iter().map(|p| p[1]);
            let b = (
                xs.clone().fold(f64::MAX, f64::min),
                ys.clone().fold(f64::MAX, f64::min),
                xs.fold(f64::MIN, f64::max),
                ys.fold(f64::MIN, f64::max),
            );
            let n = z.points.len() as f64;
            let c = (z.points.iter().map(|p| p[0]).sum::<f64>() / n, z.points.iter().map(|p| p[1]).sum::<f64>() / n);
            (b, c)
        }
        _ => ((z.x, z.y, z.x, z.y), (z.x, z.y)),
    }
}

fn inside(z: &Zone, x: f64, y: f64) -> bool {
    let pad = z.pad.max(0.0);
    match z.shape.as_str() {
        "circle" => ((x - z.x).powi(2) + (y - z.y).powi(2)).sqrt() <= (z.r - pad).max(0.0),
        "rect" => x >= z.x + pad && x <= z.x + z.w - pad && y >= z.y + pad && y <= z.y + z.h - pad,
        "poly" => point_in_poly(&z.points, x, y) && poly_edge_dist(&z.points, x, y) >= pad,
        _ => true,
    }
}

/// Samples a point in client coordinates. `last` drives anti-repeat.
pub fn sample_zone(rng: &mut Rng, z: &Zone, last: Option<(f64, f64)>) -> (f64, f64) {
    if z.shape == "point" {
        return (z.x, z.y);
    }
    let ((x0, y0, x1, y1), (cx, cy)) = zone_bounds(z);
    let (w, h) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
    let gaussian = z.dist != "uniform";
    let mut fallback = (cx, cy);
    for attempt in 0..400 {
        let (x, y) = if gaussian {
            (cx + rng.gauss() * w / 5.0, cy + rng.gauss() * h / 5.0)
        } else if z.shape == "circle" {
            let r = z.r * rng.f().sqrt();
            let a = rng.f() * std::f64::consts::TAU;
            (z.x + r * a.cos(), z.y + r * a.sin())
        } else {
            (x0 + rng.f() * w, y0 + rng.f() * h)
        };
        if !inside(z, x, y) {
            continue;
        }
        fallback = (x, y);
        if let Some((lx, ly)) = last {
            if z.anti_repeat > 0.0 && attempt < 300 && ((x - lx).powi(2) + (y - ly).powi(2)).sqrt() < z.anti_repeat {
                continue;
            }
        }
        return (x, y);
    }
    fallback
}

/// Movement duration in ms, Fitts-style: longer distance and smaller target
/// take longer.
pub fn move_duration(dist: f64, target: f64, speed: f64) -> f64 {
    let id = (dist / target.max(8.0) + 1.0).log2();
    ((90.0 + 105.0 * id) / speed.max(0.1)).clamp(40.0, 1400.0)
}

/// Cubic Bézier path from a to b with random bow, eased (minimum-jerk-ish).
/// Returns (x, y, t_fraction) points; t is 0..1 of the total duration.
pub fn bezier_path(rng: &mut Rng, a: (f64, f64), b: (f64, f64), curvature: f64, n: usize) -> Vec<(f64, f64, f64)> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let d = (dx * dx + dy * dy).sqrt().max(1.0);
    let (nx, ny) = (-dy / d, dx / d);
    let bow = curvature.clamp(0.0, 1.0) * d * 0.35;
    let o1 = rng.range(-bow, bow);
    let o2 = rng.range(-bow, bow) * 0.6;
    let c1 = (a.0 + dx * rng.range(0.2, 0.4) + nx * o1, a.1 + dy * rng.range(0.2, 0.4) + ny * o1);
    let c2 = (a.0 + dx * rng.range(0.6, 0.85) + nx * o2, a.1 + dy * rng.range(0.6, 0.85) + ny * o2);
    let n = n.max(2);
    (1..=n)
        .map(|i| {
            let s = i as f64 / n as f64;
            // Minimum-jerk easing: slow start, fast middle, slow end.
            let u = s * s * s * (10.0 - 15.0 * s + 6.0 * s * s);
            let v = 1.0 - u;
            let x = v * v * v * a.0 + 3.0 * v * v * u * c1.0 + 3.0 * v * u * u * c2.0 + u * u * u * b.0;
            let y = v * v * v * a.1 + 3.0 * v * v * u * c1.1 + 3.0 * v * u * u * c2.1 + u * u * u * b.1;
            (x, y, s)
        })
        .collect()
}

pub fn hex_rgb(hex: &str) -> [u8; 3] {
    let h = hex.trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    [p(0), p(2), p(4)]
}

fn lab(c: [u8; 3]) -> [f64; 3] {
    let lin = |v: u8| {
        let v = v as f64 / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (lin(c[0]), lin(c[1]), lin(c[2]));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f64| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIE76 colour difference.
pub fn delta_e(a: [u8; 3], b: [u8; 3]) -> f64 {
    let (p, q) = (lab(a), lab(b));
    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
}

pub fn to_hex(c: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", c[0], c[1], c[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_stay_inside_shapes() {
        let mut rng = Rng::new();
        let rect = Zone { shape: "rect".into(), x: 10.0, y: 10.0, w: 100.0, h: 40.0, pad: 4.0, ..Zone::default() };
        let circ = Zone { shape: "circle".into(), x: 50.0, y: 50.0, r: 20.0, dist: "uniform".into(), ..Zone::default() };
        let poly = Zone {
            shape: "poly".into(),
            points: vec![[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]],
            anti_repeat: 5.0,
            ..Zone::default()
        };
        let mut last = None;
        for _ in 0..2000 {
            let (x, y) = sample_zone(&mut rng, &rect, None);
            assert!((14.0..=106.0).contains(&x) && (14.0..=46.0).contains(&y));
            let (x, y) = sample_zone(&mut rng, &circ, None);
            assert!(((x - 50.0).powi(2) + (y - 50.0).powi(2)).sqrt() <= 20.0);
            let p = sample_zone(&mut rng, &poly, last);
            assert!(point_in_poly(&poly.points, p.0, p.1));
            last = Some(p);
        }
    }

    #[test]
    fn timing_is_clamped() {
        let mut rng = Rng::new();
        let t = Timing { dist: "gaussian".into(), mean: 400.0, spread: 50.0 };
        for _ in 0..5000 {
            let v = sample_timing(&mut rng, &t);
            assert!((300.0..=500.0).contains(&v));
        }
    }

    #[test]
    fn delta_e_identity() {
        assert!(delta_e([10, 20, 30], [10, 20, 30]) < 1e-9);
        assert!(delta_e([0, 0, 0], [255, 255, 255]) > 90.0);
        assert_eq!(hex_rgb("#4A90E2"), [0x4a, 0x90, 0xe2]);
    }
}
