//! UTC day numbers (days since 1970-01-01) and `YYYY-MM-DD` names, without a date library.

/// Days since the Unix epoch (UTC).
pub type Day = i32;

pub const NS_PER_DAY: i64 = 86_400_000_000_000;

pub fn day_of(ts_ns: i64) -> Day {
    ts_ns.div_euclid(NS_PER_DAY) as Day
}

pub fn day_start_ns(d: Day) -> i64 {
    i64::from(d) * NS_PER_DAY
}

/// (year, month, day) from days since epoch (H. Hinnant's civil_from_days).
pub fn civil(d: Day) -> (i32, u32, u32) {
    let z = i64::from(d) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, dd)
}

/// Days since epoch from a civil date (H. Hinnant's days_from_civil).
pub fn from_civil(y: i32, m: u32, d: u32) -> Day {
    let y = i64::from(if m <= 2 { y - 1 } else { y });
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as Day
}

pub fn day_name(d: Day) -> String {
    let (y, m, dd) = civil(d);
    format!("{y:04}-{m:02}-{dd:02}")
}

/// Parses `YYYY-MM-DD`.
pub fn parse_day(s: &str) -> Option<Day> {
    let mut it = s.split('-');
    let y: i32 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    if it.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let day = from_civil(y, m, d);
    (civil(day) == (y, m, d)).then_some(day)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for a nanosecond timestamp.
pub fn iso_utc(ts_ns: i64) -> String {
    let d = day_of(ts_ns);
    let ns = ts_ns - day_start_ns(d);
    let ms = ns / 1_000_000;
    let (h, mi, s, milli) = (
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000,
    );
    format!("{}T{h:02}:{mi:02}:{s:02}.{milli:03}Z", day_name(d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        assert_eq!(day_name(0), "1970-01-01");
        assert_eq!(parse_day("2026-11-04"), Some(from_civil(2026, 11, 4)));
        assert_eq!(day_name(from_civil(2024, 2, 29)), "2024-02-29");
        assert_eq!(parse_day("2023-02-29"), None);
        assert_eq!(parse_day("2026-13-01"), None);
        assert_eq!(parse_day("nope"), None);
        for d in [-1000, -1, 0, 1, 19_000, 20_396, 40_000] {
            assert_eq!(parse_day(&day_name(d)), Some(d));
        }
        assert_eq!(day_of(-1), -1);
        assert_eq!(
            iso_utc(1_700_000_000_123_000_000),
            "2023-11-14T22:13:20.123Z"
        );
    }
}
