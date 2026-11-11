//! Small parsing helpers shared by the venue crates.
use std::time::{SystemTime, UNIX_EPOCH};

use htflow_core_types::TickSize;
use serde_json::Value;

use crate::{ConnectorError, Result};

pub fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

const MASK53: u64 = (1 << 53) - 1;

fn fnv(bytes: impl IntoIterator<Item = u8>) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h & MASK53
}

/// Venue trade id → u64 that survives JavaScript numbers: numeric ids ≤ 2^53 are kept, anything
/// else (UUIDs, "ETH-123", huge numbers) is hashed (FNV-1a) into 53 bits.
pub fn hash_id(s: &str) -> u64 {
    if let Ok(v) = s.parse::<u64>() {
        if v <= MASK53 {
            return v;
        }
    }
    fnv(s.bytes())
}

/// Deterministic id for venues that publish none (Phemex): the same trade gets the same id from
/// REST and WebSocket, so the history/live seam de-duplicates it.
pub fn synthetic_id(ts_ns: i64, px: i64, qty: f64, side: i8) -> u64 {
    let mut b = Vec::with_capacity(25);
    b.extend_from_slice(&ts_ns.to_le_bytes());
    b.extend_from_slice(&px.to_le_bytes());
    b.extend_from_slice(&qty.to_bits().to_le_bytes());
    b.push(side as u8);
    fnv(b).max(1)
}

pub fn parse_f64(s: &str) -> Result<f64> {
    s.trim()
        .parse()
        .map_err(|e: std::num::ParseFloatError| ConnectorError::Other(format!("{e}: {s:?}")))
}

/// Contracts × contract value, rounded to `precision` decimals (avoids 0.12000000000000001).
pub fn scale_qty(qty: f64, contract_value: f64, precision: u32) -> f64 {
    if contract_value == 1.0 {
        return qty;
    }
    let f = 10f64.powi(precision.min(12) as i32);
    (qty * contract_value * f).round() / f
}

/// A JSON number or numeric string as its decimal text (numbers print in shortest round-trip form).
pub fn num_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A JSON number or numeric string as f64.
pub fn num_f64(v: &Value) -> Option<f64> {
    match v {
        Value::String(s) => s.trim().parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// Price given as f64 → ticks, exactly (via the shortest decimal representation).
pub fn f64_ticks(tick: &TickSize, v: f64) -> Result<i64> {
    if !v.is_finite() {
        return Err(ConnectorError::Other(format!("bad price {v}")));
    }
    Ok(tick.parse_ticks(&format!("{v}"))?)
}

/// `[[price, qty, ...], ...]` with string or number cells → `(ticks, qty)` rows.
pub fn levels(tick: &TickSize, rows: &[Vec<Value>]) -> Result<Vec<(i64, f64)>> {
    rows.iter()
        .map(|r| {
            let p = r.first().and_then(num_text);
            let q = r.get(1).and_then(num_f64);
            match (p, q) {
                (Some(p), Some(q)) => Ok((tick.parse_ticks(&p)?, q)),
                _ => Err(ConnectorError::Other("bad book level".into())),
            }
        })
        .collect()
}

/// Same as [`levels`] but keeps the venue's original strings (for checksums).
pub fn raw_levels(tick: &TickSize, rows: &[Vec<Value>]) -> Result<Vec<(i64, f64, String, String)>> {
    rows.iter()
        .map(|r| {
            let p = r.first().and_then(num_text);
            let q = r.get(1).and_then(num_text);
            match (p, q) {
                (Some(p), Some(q)) => Ok((tick.parse_ticks(&p)?, parse_f64(&q)?, p, q)),
                _ => Err(ConnectorError::Other("bad book level".into())),
            }
        })
        .collect()
}

/// CRC-32 (IEEE 802.3), as used by OKX and Bitget book checksums.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn ms_of(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> i64 {
    ((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms
}

/// `2019-02-14T09:25:33.920Z` (UTC, optional fraction) → ms since epoch.
pub fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let s = s.trim().trim_end_matches('Z');
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    let frac: String = frac
        .chars()
        .take_while(char::is_ascii_digit)
        .take(3)
        .collect();
    let ms = if frac.is_empty() {
        0
    } else {
        frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32)
    };
    Some(ms_of(y, mo, da, h, mi, se, ms))
}

/// HTTP `Date` header (`Tue, 15 Nov 1994 08:12:31 GMT`) → ms since epoch.
pub fn parse_http_date_ms(s: &str) -> Option<i64> {
    let mut it = s.split_whitespace().skip(1);
    let d: i64 = it.next()?.parse().ok()?;
    let mo = match it.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let y: i64 = it.next()?.parse().ok()?;
    let mut t = it.next()?.split(':').map(|x| x.parse::<i64>().ok());
    Some(ms_of(y, mo, d, t.next()??, t.next()??, t.next()??, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_numbers() {
        assert_eq!(hash_id("130639474"), 130_639_474);
        assert!(hash_id("20f43950-d8dd-5b31-9112-a178eb6023af") < 1 << 53);
        assert!(hash_id("18446744073709551615") < 1 << 53);
        assert_eq!(scale_qty(12.0, 0.01, 2), 0.12);
        assert_eq!(scale_qty(3.0, 1.0, 0), 3.0);
        assert_eq!(synthetic_id(1, 2, 3.0, 1), synthetic_id(1, 2, 3.0, 1));
        assert_ne!(synthetic_id(1, 2, 3.0, 1), synthetic_id(1, 2, 3.0, -1));
        let t = TickSize::parse("0.5").unwrap();
        assert_eq!(f64_ticks(&t, 34_892.5).unwrap(), 69_785);
        let rows: Vec<Vec<Value>> =
            serde_json::from_str(r#"[["100.5","2"],[101,"0.25"],[102.0,3]]"#).unwrap();
        assert_eq!(
            levels(&t, &rows).unwrap(),
            vec![(201, 2.0), (202, 0.25), (204, 3.0)]
        );
        assert!(levels(&t, &[vec![Value::Null]]).is_err());
    }

    #[test]
    fn crc_and_dates() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(
            parse_iso8601_ms("2019-02-14T09:25:33.920Z"),
            Some(1_550_136_333_920)
        );
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_http_date_ms("Tue, 15 Nov 1994 08:12:31 GMT"),
            Some(784_887_151_000)
        );
        assert_eq!(parse_http_date_ms("garbage"), None);
    }
}
