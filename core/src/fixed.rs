//! Integer trigonometry and square roots, so the sim and the browser compute
//! bit-identical results. Floating-point `sin` differs between native libm
//! and the one compiled into WebAssembly.

/// A unit length in [`sin`] and [`cos`]: 1.0 is `1 << 14`.
pub const ONE: i32 = 1 << 14;

/// A quarter turn of sines in 1025 steps, `ONE` at the top.
const QUARTER: [i32; 1025] = {
    let mut table = [0; 1025];
    let mut i = 0;
    while i <= 1024 {
        table[i] = quarter_sine(i as i128);
        i += 1;
    }
    table
};

/// `sin(i / 1024 * π/2)` by its Taylor series in 32-bit fixed point.
const fn quarter_sine(i: i128) -> i32 {
    const PI: i128 = 13_493_037_705; // π * 2^32
    let x = i * PI / 2048;
    let mut term = x;
    let mut sum = x;
    let mut n = 1;
    while n < 12 {
        term = -term * x / (1 << 32) * x / (1 << 32) / ((2 * n) * (2 * n + 1));
        sum += term;
        n += 1;
    }
    ((sum + (1 << 17)) >> 18) as i32
}

/// The sine of `heading`, where 65536 is a full turn, scaled by [`ONE`].
pub fn sin(heading: u16) -> i32 {
    let step = usize::from(heading.wrapping_add(8) >> 4);
    let within = step & 1023;
    match step >> 10 {
        0 => QUARTER[within],
        1 => QUARTER[1024 - within],
        2 => -QUARTER[within],
        _ => -QUARTER[1024 - within],
    }
}

/// The cosine of `heading`, scaled by [`ONE`].
pub fn cos(heading: u16) -> i32 {
    sin(heading.wrapping_add(16384))
}

/// `value * unit / ONE`, rounded to nearest.
pub fn scale(value: i32, unit: i32) -> i32 {
    div_round(value * unit, ONE)
}

/// `a / b`, rounded half away from zero. `b` must be positive.
pub fn div_round(a: i32, b: i32) -> i32 {
    if a >= 0 {
        (a + b / 2) / b
    } else {
        (a - b / 2) / b
    }
}

/// The length of `(x, z)`, rounded down.
pub fn length(x: i32, z: i32) -> i32 {
    let squared = i64::from(x) * i64::from(x) + i64::from(z) * i64::from(z);
    isqrt(squared) as i32
}

fn isqrt(n: i64) -> i64 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[cfg(test)]
mod tests {
    use super::{ONE, cos, length, sin};

    #[test]
    fn sine_matches_the_float_one_closely() {
        for heading in (0..=u16::MAX).step_by(97) {
            let angle = f64::from(heading) / 65536.0 * std::f64::consts::TAU;
            let expected = angle.sin() * f64::from(ONE);
            // The table has 4096 steps a turn, so up to half a step apart.
            assert!(
                (f64::from(sin(heading)) - expected).abs() < 14.0,
                "{heading}"
            );
        }
        assert_eq!((sin(0), cos(0)), (0, ONE));
        assert_eq!((sin(16384), cos(16384)), (ONE, 0));
        assert_eq!((sin(32768), cos(32768)), (0, -ONE));
    }

    #[test]
    fn lengths() {
        assert_eq!(length(3, 4), 5);
        assert_eq!(length(-30_000, 40_000), 50_000);
        assert_eq!(length(0, 0), 0);
        assert_eq!(length(1, 1), 1);
    }
}
