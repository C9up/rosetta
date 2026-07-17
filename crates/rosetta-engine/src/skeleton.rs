pub(crate) fn validate_number_style(style: &str) -> Result<(), String> {
    if !style.starts_with("::") {
        return Ok(());
    }
    let skeleton = style[2..].trim();
    if skeleton.is_empty() {
        return Err("Empty ICU number skeleton".to_string());
    }
    for token in skeleton.split_whitespace() {
        validate_number_token(token)?;
    }
    Ok(())
}

fn validate_number_token(token: &str) -> Result<(), String> {
    const FIXED: &[&str] = &[
        "compact-long",
        "compact-short",
        "K",
        "KK",
        "notation-simple",
        "percent",
        "%",
        "%x100",
        "permille",
        "base-unit",
        "group-off",
        ",_",
        "group-min2",
        ",?",
        "group-on-aligned",
        ",!",
        "group-auto",
        "group-thousands",
        "sign-always",
        "+!",
        "sign-auto",
        "sign-never",
        "+_",
        "sign-except-zero",
        "+?",
        "sign-negative",
        "+-",
        "sign-accounting",
        "sign-accounting-always",
        "sign-accounting-except-zero",
        "sign-accounting-negative",
        "()",
        "()!",
        "()?",
        "()-",
        "unit-width-narrow",
        "unit-width-short",
        "unit-width-full-name",
        "unit-width-iso-code",
        "unit-width-hidden",
        "precision-integer",
        ".",
        "precision-unlimited",
        "precision-currency-standard",
        "precision-currency-standard/w",
        "integer-width-trunc",
        "latin",
        "decimal-always",
        "decimal-auto",
    ];
    if FIXED.contains(&token) || token.bytes().all(|byte| byte == b'0') {
        return Ok(());
    }

    for prefix in [
        "currency/",
        "measure-unit/",
        "unit/",
        "per-measure-unit/",
        "numbering-system/",
    ] {
        if let Some(value) = token.strip_prefix(prefix) {
            if !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Ok(());
            }
            return Err(format!("Invalid ICU number skeleton token '{token}'"));
        }
    }

    if token == "scientific" || token == "engineering" {
        return Ok(());
    }
    if let Some(options) = token
        .strip_prefix("scientific/")
        .or_else(|| token.strip_prefix("engineering/"))
    {
        if !options.is_empty()
            && options.split('/').all(|option| {
                matches!(
                    option,
                    "sign-always" | "sign-except-zero" | "sign-never" | "sign-auto"
                ) || exponent_width(option)
            })
        {
            return Ok(());
        }
        return Err(format!("Unsupported ICU scientific option in '{token}'"));
    }
    if concise_scientific(token) || fraction_precision(token) || significant_precision(token) {
        return Ok(());
    }

    if token.starts_with("precision-currency-cash") {
        return Err("ICU cash currency precision is not representable by Intl".to_string());
    }
    if let Some(value) = token.strip_prefix("precision-increment/") {
        if value
            .parse::<f64>()
            .is_ok_and(|number| number.is_finite() && number > 0.0)
        {
            return Ok(());
        }
        return Err(format!("Invalid ICU rounding increment '{value}'"));
    }
    if let Some(mode) = token.strip_prefix("rounding-mode-") {
        if matches!(
            mode,
            "ceiling" | "floor" | "down" | "up" | "half-even" | "half-down" | "half-up"
        ) {
            return Ok(());
        }
        return Err(format!("Unsupported ICU rounding mode '{mode}'"));
    }
    if let Some(width) = token.strip_prefix("integer-width/") {
        if valid_integer_width(width) {
            return Ok(());
        }
        return Err(format!("Invalid ICU integer width '{width}'"));
    }
    if let Some(value) = token.strip_prefix("scale/") {
        if value.parse::<f64>().is_ok_and(f64::is_finite) {
            return Ok(());
        }
        return Err(format!("Invalid ICU scale '{token}'"));
    }

    Err(format!("Unsupported ICU number skeleton token '{token}'"))
}

fn exponent_width(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && matches!(bytes[0], b'*' | b'+')
        && bytes[1..].iter().all(|byte| *byte == b'e')
}

fn concise_scientific(value: &str) -> bool {
    let rest = value.strip_prefix("EE").or_else(|| value.strip_prefix('E'));
    let Some(mut rest) = rest else { return false };
    if let Some(value) = rest.strip_prefix("+!").or_else(|| rest.strip_prefix("+?")) {
        rest = value;
    }
    !rest.is_empty() && rest.bytes().all(|byte| byte == b'0')
}

fn fraction_precision(value: &str) -> bool {
    let Some(body) = value.strip_prefix('.') else {
        return false;
    };
    let (precision, significant) = body.split_once('/').unwrap_or((body, ""));
    if !precision
        .bytes()
        .all(|byte| matches!(byte, b'0' | b'#' | b'*' | b'+'))
    {
        return false;
    }
    significant.is_empty() || significant == "w" || significant_precision(significant)
}

fn significant_precision(value: &str) -> bool {
    let body = value
        .strip_suffix('r')
        .or_else(|| value.strip_suffix('s'))
        .unwrap_or(value);
    let at_count = body.bytes().take_while(|byte| *byte == b'@').count();
    at_count > 0
        && body[at_count..]
            .bytes()
            .all(|byte| matches!(byte, b'#' | b'*' | b'+'))
}

fn valid_integer_width(value: &str) -> bool {
    let body = value
        .strip_prefix('*')
        .or_else(|| value.strip_prefix('+'))
        .unwrap_or(value);
    !body.is_empty() && body.bytes().all(|byte| matches!(byte, b'#' | b'0')) && body.contains('0')
}

pub(crate) fn validate_date_style(style: &str, kind: &str) -> Result<(), String> {
    if !style.starts_with("::") {
        return Ok(());
    }
    let skeleton = style[2..].trim();
    if skeleton.is_empty() {
        return Err(format!("Empty ICU {kind} skeleton"));
    }
    if skeleton.bytes().any(|byte| {
        !(byte.is_ascii_alphabetic() || byte.is_ascii_whitespace() || b":.,/-".contains(&byte))
    }) {
        return Err(format!("Invalid ICU {kind} skeleton '{style}'"));
    }

    let mut fields = 0;
    let mut chars = skeleton.chars().peekable();
    while let Some(symbol) = chars.next() {
        if !symbol.is_ascii_alphabetic() {
            continue;
        }
        fields += 1;
        let mut length = 1;
        while chars.peek() == Some(&symbol) {
            chars.next();
            length += 1;
        }
        match symbol {
            'y' | 'M' | 'L' | 'd' | 'E' | 'G' | 'h' | 'H' | 'K' | 'k' | 'j' | 'a' | 'm' | 's'
            | 'z' | 'v' | 'O' | 'X' | 'x' => {}
            'e' | 'c' if length <= 3 => {
                return Err(format!(
                    "ICU date skeleton field '{}' is not supported by Intl",
                    symbol.to_string().repeat(length)
                ));
            }
            'e' | 'c' => {}
            'S' if length > 3 => {
                return Err("Intl supports at most 3 fractional second digits".to_string());
            }
            'S' => {}
            _ => {
                return Err(format!(
                    "Unsupported ICU date skeleton field '{}'",
                    symbol.to_string().repeat(length)
                ));
            }
        }
    }
    if fields == 0 {
        return Err(format!("Invalid ICU {kind} skeleton '{style}'"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_number_skeletons() {
        validate_number_style("::currency/EUR precision-integer group-min2").unwrap();
        validate_number_style("::scientific/*ee/sign-always .00##").unwrap();
        assert!(validate_number_style("::").is_err());
        assert!(validate_number_style("::currency/").is_err());
        assert!(validate_number_style("::integer-width/wat").is_err());
        assert!(validate_number_style("::sign-accounting-wat").is_err());
    }

    #[test]
    fn validates_date_skeletons() {
        validate_date_style("::yyyyMMdd HH:mm:ss", "date").unwrap();
        assert!(validate_date_style("::", "date").is_err());
        assert!(validate_date_style("::yQQQ", "date").is_err());
        assert!(validate_date_style("::SSSS", "time").is_err());
    }
}
