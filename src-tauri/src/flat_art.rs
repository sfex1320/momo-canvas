//! 平面拆件预处理：按颜色统计聚类，不生成纹理，不移动透明边界或像素位置。
use image::RgbaImage;
use std::collections::BTreeMap;

/// 加权色彩聚类。颜色数量由用户决定；完全透明像素不参与，半透明像素保留原 alpha。
pub fn clean_colors(source: &RgbaImage, count: usize) -> RgbaImage {
    let mut bins: BTreeMap<u16, ([u64; 3], u64)> = BTreeMap::new();
    for p in source.pixels() {
        if p[3] < 16 {
            continue;
        }
        let key = ((p[0] as u16 >> 3) << 10) | ((p[1] as u16 >> 3) << 5) | (p[2] as u16 >> 3);
        let e = bins.entry(key).or_default();
        for i in 0..3 {
            e.0[i] += p[i] as u64;
        }
        e.1 += 1;
    }
    let samples: Vec<([f64; 3], u64)> = bins
        .values()
        .map(|(sum, n)| {
            (
                [
                    sum[0] as f64 / *n as f64,
                    sum[1] as f64 / *n as f64,
                    sum[2] as f64 / *n as f64,
                ],
                *n,
            )
        })
        .collect();
    if samples.is_empty() {
        return source.clone();
    }
    let dist = |a: &[f64; 3], b: &[f64; 3]| (0..3).map(|i| (a[i] - b[i]).powi(2)).sum::<f64>();
    let mut centers = vec![samples.iter().max_by_key(|s| s.1).unwrap().0];
    while centers.len() < count.clamp(2, 64).min(samples.len()) {
        let best = samples
            .iter()
            .max_by(|a, b| {
                let score = |s: &([f64; 3], u64)| {
                    centers
                        .iter()
                        .map(|c| dist(&s.0, c))
                        .fold(f64::INFINITY, f64::min)
                        * (s.1 as f64).sqrt()
                };
                score(a).total_cmp(&score(b))
            })
            .unwrap()
            .0;
        if centers.iter().any(|c| dist(c, &best) < 1.) {
            break;
        }
        centers.push(best);
    }
    for _ in 0..8 {
        let mut sums = vec![([0.; 3], 0u64); centers.len()];
        for (c, n) in &samples {
            let i = centers
                .iter()
                .enumerate()
                .min_by(|a, b| dist(c, a.1).total_cmp(&dist(c, b.1)))
                .unwrap()
                .0;
            for k in 0..3 {
                sums[i].0[k] += c[k] * *n as f64;
            }
            sums[i].1 += n;
        }
        for (i, (sum, n)) in sums.iter().enumerate() {
            if *n > 0 {
                for k in 0..3 {
                    centers[i][k] = sum[k] / *n as f64;
                }
            }
        }
    }
    // 32768 桶查表避免大图逐像素搜索色盘；同一桶统一颜色，消除压缩造成的微小色阶。
    let lookup: BTreeMap<u16, [u8; 3]> = bins
        .iter()
        .map(|(key, (sum, n))| {
            let c = [
                sum[0] as f64 / *n as f64,
                sum[1] as f64 / *n as f64,
                sum[2] as f64 / *n as f64,
            ];
            let nearest = centers
                .iter()
                .min_by(|a, b| dist(&c, a).total_cmp(&dist(&c, b)))
                .unwrap();
            (
                *key,
                [
                    nearest[0].round() as u8,
                    nearest[1].round() as u8,
                    nearest[2].round() as u8,
                ],
            )
        })
        .collect();
    let mut out = source.clone();
    for p in out.pixels_mut() {
        if p[3] < 16 {
            continue;
        }
        let key = ((p[0] as u16 >> 3) << 10) | ((p[1] as u16 >> 3) << 5) | (p[2] as u16 >> 3);
        if let Some(c) = lookup.get(&key) {
            for i in 0..3 {
                p[i] = c[i];
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_alpha_and_thin_lines() {
        let mut img = RgbaImage::from_pixel(64, 32, image::Rgba([250, 250, 250, 255]));
        for y in 0..32 {
            for x in 0..32 {
                img.put_pixel(
                    x,
                    y,
                    image::Rgba([220 + (x % 5) as u8, 20, 25, (y * 8) as u8]),
                );
            }
            img.put_pixel(40, y, image::Rgba([0, 0, 0, 255]));
        }
        let out = clean_colors(&img, 3);
        assert!(img.pixels().zip(out.pixels()).all(|(a, b)| a[3] == b[3]));
        assert_eq!(out.get_pixel(40, 12)[0], 0);
        let colors: std::collections::HashSet<_> = out
            .pixels()
            .filter(|p| p[3] >= 16)
            .map(|p| [p[0], p[1], p[2]])
            .collect();
        assert!(colors.len() <= 3);
    }
}
