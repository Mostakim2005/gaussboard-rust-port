// src-tauri/src/geometry.rs
// Geometry, RDP simplification, and cubic Bézier fitting preserving timestamps (TRAP 2).

use bytemuck::{cast_slice, try_cast_slice, Pod, Zeroable};
use kurbo::{BezPath, ParamCurveArclen, Point, Rect, Shape};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable, Serialize, Deserialize)]
pub struct RawInkPoint {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
    pub t_ms: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable, Serialize, Deserialize)]
pub struct TimedBezierSegment {
    pub p0: [f32; 2],
    pub p1: [f32; 2],
    pub p2: [f32; 2],
    pub p3: [f32; 2],
    pub p_start: f32,
    pub p_end: f32,
    pub t_start: u32,
    pub t_end: u32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StrokePoint {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub p: f64, // Pressure (0.0 to 1.0)
    #[serde(default)]
    pub t: f64, // Timestamp in milliseconds (TRAP 2 Invariant)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct FittedCubicSegment {
    pub p0: (f64, f64),
    pub p1: (f64, f64),
    pub p2: (f64, f64),
    pub p3: (f64, f64),
    pub t_start: f64,
    pub t_end: f64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct StrokeFitResult {
    pub segments: Vec<FittedCubicSegment>,
    pub bounds: (f64, f64, f64, f64), // (min_x, min_y, max_x, max_y)
    pub total_arc_length: f64,
    pub original_count: usize,
    pub simplified_count: usize,
}

/// Simplifies spatial coordinates while strictly preserving original hardware timestamps.
pub fn simplify_and_fit_timed_bezier(
    raw: &[RawInkPoint],
    epsilon: f64,
) -> Vec<TimedBezierSegment> {
    if raw.len() < 2 {
        return Vec::new();
    }

    // 1. Index-preserving iterative Ramer-Douglas-Peucker
    let mut keep = vec![false; raw.len()];
    keep[0] = true;
    keep[raw.len() - 1] = true;
    let mut stack = vec![(0usize, raw.len() - 1)];
    let eps_sq = epsilon * epsilon;

    while let Some((start, end)) = stack.pop() {
        if end - start <= 1 {
            continue;
        }
        let a = Point::new(raw[start].x as f64, raw[start].y as f64);
        let b = Point::new(raw[end].x as f64, raw[end].y as f64);
        let ab = b - a;
        let ab_len_sq = ab.hypot2();

        let mut max_dist_sq = 0.0;
        let mut max_idx = start;

        for i in (start + 1)..end {
            let p = Point::new(raw[i].x as f64, raw[i].y as f64);
            let dist_sq = if ab_len_sq < 1e-12 {
                (p - a).hypot2()
            } else {
                let proj = ((p - a).dot(ab) / ab_len_sq).clamp(0.0, 1.0);
                (p - (a + ab * proj)).hypot2()
            };
            if dist_sq > max_dist_sq {
                max_dist_sq = dist_sq;
                max_idx = i;
            }
        }

        // Force-keep vertices if time gap exceeds 80ms so slow pen pauses never lose timing
        let time_gap = raw[end].t_ms.saturating_sub(raw[start].t_ms);
        if max_dist_sq > eps_sq || (time_gap > 80 && end - start > 4) {
            let split_idx = if max_idx > start { max_idx } else { (start + end) / 2 };
            keep[split_idx] = true;
            stack.push((start, split_idx));
            stack.push((split_idx, end));
        }
    }

    let pts: Vec<RawInkPoint> = raw
        .iter()
        .enumerate()
        .filter_map(|(i, &pt)| if keep[i] { Some(pt) } else { None })
        .collect();

    // 2. Convert surviving timed points into C1-continuous Cubic Bézier segments
    let n = pts.len();
    let mut segments = Vec::with_capacity(n.saturating_sub(1));

    for i in 0..(n - 1) {
        let prev = if i == 0 { pts[0] } else { pts[i - 1] };
        let curr = pts[i];
        let next = pts[i + 1];
        let next2 = if i + 2 < n { pts[i + 2] } else { pts[n - 1] };

        // Catmull-Rom tangents scaled by 1/6
        let c1 = [
            curr.x + (next.x - prev.x) / 6.0,
            curr.y + (next.y - prev.y) / 6.0,
        ];
        let c2 = [
            next.x - (next2.x - curr.x) / 6.0,
            next.y - (next2.y - curr.y) / 6.0,
        ];

        segments.push(TimedBezierSegment {
            p0: [curr.x, curr.y],
            p1: c1,
            p2: c2,
            p3: [next.x, next.y],
            p_start: curr.pressure,
            p_end: next.pressure,
            t_start: curr.t_ms,
            t_end: next.t_ms.max(curr.t_ms + 1),
        });
    }

    segments
}

/// Ramer-Douglas-Peucker (RDP) algorithm with strict timestamp (p.t) preservation
pub fn simplify_rdp(points: &[StrokePoint], epsilon: f64) -> Vec<StrokePoint> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut dmax = 0.0;
    let mut index = 0;
    let end = points.len() - 1;

    for i in 1..end {
        let d = perpendicular_distance(&points[i], &points[0], &points[end]);
        if d > dmax {
            index = i;
            dmax = d;
        }
    }

    if dmax > epsilon {
        let mut rec1 = simplify_rdp(&points[0..=index], epsilon);
        let rec2 = simplify_rdp(&points[index..=end], epsilon);
        rec1.pop();
        rec1.extend(rec2);
        rec1
    } else {
        vec![points[0].clone(), points[end].clone()]
    }
}

fn perpendicular_distance(p: &StrokePoint, a: &StrokePoint, b: &StrokePoint) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mag = (dx * dx + dy * dy).sqrt();
    if mag == 0.0 {
        return ((p.x - a.x).powi(2) + (p.y - a.y).powi(2)).sqrt();
    }
    ((dy * p.x - dx * p.y + b.x * a.y - b.y * a.x).abs()) / mag
}

#[tauri::command]
pub fn stroke_simplify_and_fit(
    points: Vec<StrokePoint>,
    epsilon: Option<f64>,
) -> Result<StrokeFitResult, String> {
    let original_count = points.len();
    if original_count < 2 {
        return Err("Stroke requires at least 2 points for curve fitting".into());
    }

    let eps = epsilon.unwrap_or(0.75);
    let simplified = simplify_rdp(&points, eps);
    let simplified_count = simplified.len();

    let mut segments = Vec::new();
    let mut bez_path = BezPath::new();
    bez_path.move_to(Point::new(simplified[0].x, simplified[0].y));

    for i in 0..simplified.len() - 1 {
        let p0 = if i == 0 { &simplified[0] } else { &simplified[i - 1] };
        let p1 = &simplified[i];
        let p2 = &simplified[i + 1];
        let p3 = if i + 2 < simplified.len() { &simplified[i + 2] } else { p2 };

        let c1_x = p1.x + (p2.x - p0.x) / 6.0;
        let c1_y = p1.y + (p2.y - p0.y) / 6.0;
        let c2_x = p2.x - (p3.x - p1.x) / 6.0;
        let c2_y = p2.y - (p3.y - p1.y) / 6.0;

        bez_path.curve_to(
            Point::new(c1_x, c1_y),
            Point::new(c2_x, c2_y),
            Point::new(p2.x, p2.y),
        );

        segments.push(FittedCubicSegment {
            p0: (p1.x, p1.y),
            p1: (c1_x, c1_y),
            p2: (c2_x, c2_y),
            p3: (p2.x, p2.y),
            t_start: p1.t,
            t_end: p2.t,
        });
    }

    let rect: Rect = bez_path.bounding_box();
    let total_arc_length: f64 = bez_path.segments().map(|seg| seg.arclen(1e-2)).sum();

    Ok(StrokeFitResult {
        segments,
        bounds: (rect.x0, rect.y0, rect.x1, rect.y1),
        total_arc_length,
        original_count,
        simplified_count,
    })
}

/// Zero-copy binary stroke simplification: JS ArrayBuffer -> Rust &[RawInkPoint] -> JS ArrayBuffer
#[tauri::command]
pub fn binary_simplify_stroke(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(raw_bytes) = request.body() else {
        return Err("Expected raw binary ArrayBuffer payload".into());
    };

    if raw_bytes.len() < 8 + std::mem::size_of::<RawInkPoint>() {
        return Err("Payload too short".into());
    }

    let epsilon = f64::from_le_bytes(raw_bytes[0..8].try_into().unwrap());
    let points: &[RawInkPoint] = try_cast_slice(&raw_bytes[8..])
        .map_err(|e| format!("Alignment/size mismatch: {}", e))?;

    let segments: Vec<TimedBezierSegment> = simplify_and_fit_timed_bezier(points, epsilon);
    let out_bytes: &[u8] = cast_slice(&segments);
    Ok(Response::new(out_bytes.to_vec()))
}
