//! Compatibility for editable JSON documents formerly owned by JavaScript.
//! Call explicitly for config and pane metadata, never retained response bodies.

use serde_json::Value;

pub(crate) fn parse(text: &str) -> Result<Value, serde_json::Error> {
    let mut value = serde_json::from_str(text)?;
    normalize_numbers(&mut value);
    Ok(value)
}

fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            // JSON.parse uses IEEE-754 even for opaque values. JSON.stringify
            // writes non-finite values as null. arbitrary_precision lets valid
            // exponents outside f64 reach this policy rather than fail decoding.
            *value = number
                .as_f64()
                .and_then(|number| {
                    if number.fract() == 0.0 && number >= 0.0 && number < u64::MAX as f64 {
                        Some(serde_json::Number::from(number as u64))
                    } else if number.fract() == 0.0 && number < 0.0 && number >= i64::MIN as f64 {
                        Some(serde_json::Number::from(number as i64))
                    } else {
                        serde_json::Number::from_f64(number)
                    }
                })
                .map_or(Value::Null, Value::Number);
        }
        Value::Array(values) => values.iter_mut().for_each(normalize_numbers),
        Value::Object(values) => values.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}
