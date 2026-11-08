// src-tauri/src/geometry.rs
use kurbo::{BezPath, Point, Rect, Shape};
use serde::{Deserialize, Serialize};

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
    // Step 1: Reduce points by 60-80% while strictly preserving timestamps (p.t)
    let simplified = simplify_rdp(&points, eps);
    let simplified_count = simplified.len();

    // Step 2: Fit smooth cubic Bézier curves (Catmull-Rom to Cubic conversion)
    let mut segments = Vec::new();
    let mut bez_path = BezPath::new();
    bez_path.move_to(Point::new(simplified[0].x, simplified[0].y));

    for i in 0..simplified.len() - 1 {
        let p0 = if i == 0 { &simplified[0] } else { &simplified[i - 1] };
        let p1 = &simplified[i];
        let p2 = &simplified[i + 1];
        let p3 = if i + 2 < simplified.len() { &simplified[i + 2] } else { p2 };

        // Convert Catmull-Rom spline control points to Cubic Bézier control points:
        // C1 = P1 + (P2 - P0) / 6
        // C2 = P2 - (P3 - P1) / 6
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

    // Step 3: Analytical AABB Bounding Box calculation via kurbo
    let rect: Rect = bez_path.bounding_box();
    let total_arc_length = bez_path.arclen(1e-2);

    Ok(StrokeFitResult {
        segments,
        bounds: (rect.x0, rect.y0, rect.x1, rect.y1),
        total_arc_length,
        original_count,
        simplified_count,
    })
}
