use serde_json::Value;
use std::collections::HashMap;

pub type Catalogs = HashMap<String, HashMap<String, String>>;

pub fn has_key(catalogs: &Catalogs, key: &str, chain: &[String]) -> bool {
    for locale in chain {
        if let Some(catalog) = catalogs.get(locale) {
            if catalog.contains_key(key) {
                return true;
            }
        }
    }
    false
}

pub fn translate(
    catalogs: &Catalogs,
    key: &str,
    params: Option<&HashMap<String, Value>>,
    chain: &[String],
    default_value: Option<&str>,
) -> String {
    for locale in chain {
        if let Some(catalog) = catalogs.get(locale) {
            if let Some(message) = catalog.get(key) {
                return format_message(message, params, locale);
            }
        }
    }

    if let Some(default_text) = default_value {
        let locale = chain.first().map(|s| s.as_str()).unwrap_or("en");
        return format_message(default_text, params, locale);
    }

    key.to_string()
}

// ─── ICU MessageFormat engine ──────────────────────────────────────────────────
// Handles: simple placeholders `{key}`, `select`, `plural`, `selectordinal`,
// `number`, `date`, `time`. Nested messages are supported (recursive descent).
// This replaces the previous TS `format.ts` — all formatting now runs in Rust.

/// Top-level entry point for formatting a single message string.
pub fn format_message(message: &str, params: Option<&HashMap<String, Value>>, locale: &str) -> String {
    // Fast path only when there's neither a placeholder NOR an apostrophe — the
    // latter still needs ICU quote decoding (`''` → `'`, `'{'` → `{`), even with
    // no `{` in the message (RO2).
    if !message.contains('{') && !message.contains('\'') {
        return message.to_string();
    }
    format_segment(message, params, locale)
}

fn format_segment(segment: &str, params: Option<&HashMap<String, Value>>, locale: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    let mut i = 0;

    while i < segment.len() {
        let c = segment[i..].chars().next().unwrap();
        match c {
            // ICU apostrophe quoting (RO2): `''` → literal `'`; `'` before a
            // syntax char (`{ } #`) opens a quoted span copied verbatim until the
            // next single `'`; a lone `'` is a literal apostrophe.
            '\'' => i = consume_quote(segment, i, &mut out),
            '{' => {
                let end = find_matching_brace(segment, i);
                if end == usize::MAX {
                    out.push_str(&segment[i..]);
                    break;
                }
                let content = segment[i + 1..end].trim();
                out.push_str(&resolve_token(content, params, locale));
                i = end + 1;
            }
            _ => {
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
    out
}

/// Handle ICU quoting starting at the `'` at byte index `i`. Pushes the decoded
/// literal text to `out` and returns the byte index just past the consumed quote
/// construct.
fn consume_quote(segment: &str, i: usize, out: &mut String) -> usize {
    let rest = &segment[i + 1..];
    match rest.chars().next() {
        Some('\'') => {
            out.push('\''); // `''` → literal `'`
            i + 2
        }
        Some('{') | Some('}') | Some('#') => {
            // Quoted span: copy literally until the next single `'` (with `''`
            // inside the span meaning a literal `'`).
            let mut j = i + 1;
            while j < segment.len() {
                let cc = segment[j..].chars().next().unwrap();
                if cc == '\'' {
                    if segment[j + 1..].chars().next() == Some('\'') {
                        out.push('\'');
                        j += 2;
                    } else {
                        return j + 1; // closing quote
                    }
                } else {
                    out.push(cc);
                    j += cc.len_utf8();
                }
            }
            j // unterminated quote → consumed to end
        }
        _ => {
            out.push('\''); // lone apostrophe → literal
            i + 1
        }
    }
}

fn resolve_token(content: &str, params: Option<&HashMap<String, Value>>, locale: &str) -> String {
    let parts = split_top_level(content, ',');

    // Simple placeholder: {name}
    if parts.len() == 1 {
        let key = parts[0].trim();
        return param_to_string(params, key);
    }

    let var_name = parts[0].trim();
    let kind = parts[1].trim();
    // Options = everything after the 2nd top-level comma. Use the already-split
    // `parts` (split_top_level skips commas nested in `{}`) rather than
    // `content.find(kind)`, which mis-targeted when the kind keyword reappeared in
    // an option body, e.g. `{x, select, other {pick select}}` (RO4).
    let options_owned: String = if parts.len() > 2 {
        parts[2..].join(", ")
    } else {
        String::new()
    };
    let options_raw = options_owned.as_str();

    let raw_value = params.and_then(|p| p.get(var_name));
    // A param NOT provided at all (distinct from an explicit `null`) leaves the
    // whole token intact, matching the simple-placeholder policy — a forgotten
    // `{n, plural, …}` / `{g, select, …}` stays visible instead of silently
    // defaulting to 0 / "other" / empty (RO1).
    if raw_value.is_none() {
        return format!("{{{content}}}");
    }

    match kind {
        "select" => {
            let key = match raw_value {
                Some(Value::String(s)) => s.as_str().to_string(),
                Some(v) => value_to_string(v),
                None => "other".to_string(),
            };
            let options = parse_options(options_raw);
            let selected = options.get(key.as_str())
                .or_else(|| options.get("other"))
                .cloned()
                .unwrap_or_default();
            format_segment(&selected, params, locale)
        }

        "plural" | "selectordinal" => {
            let offset = parse_offset(options_raw);
            let n = value_to_number(raw_value);
            let adjusted = n - offset as f64;
            let options = parse_options(options_raw);

            // Exact match first: `=0`, `=1`, `=5`
            let exact_key = format!("={}", n as i64);
            if let Some(msg) = options.get(exact_key.as_str()) {
                let replaced = replace_hash_top_level(msg, &format_number(adjusted));
                return format_segment(&replaced, params, locale);
            }

            // CLDR plural category
            let ordinal = kind == "selectordinal";
            let category = plural_category(adjusted, locale, ordinal);
            let selected = options.get(category)
                .or_else(|| options.get("other"))
                .cloned()
                .unwrap_or_default();
            let replaced = replace_hash_top_level(&selected, &format_number(adjusted));
            format_segment(&replaced, params, locale)
        }

        "number" => {
            let n = value_to_number(raw_value);
            let style = parts.get(2).map(|s| s.trim()).unwrap_or("");
            format_number_icu(n, style)
        }

        "date" | "time" => {
            // Simplified: render as ISO substring. Full locale-aware formatting
            // would require ICU4X (~2MB binary). ISO is correct and consistent.
            // Resolve an ISO string from EITHER a string (e.g. a JS `Date`, which
            // `JSON.stringify` serialises to ISO — RO7) OR epoch-millis number,
            // then slice the date/time portion in both cases.
            let iso = match raw_value {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) => n.as_f64().and_then(|ms| {
                    chrono::DateTime::from_timestamp((ms / 1000.0) as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
                _ => None,
            };
            match iso {
                Some(s) if kind == "date" => s.get(..10).unwrap_or(&s).to_string(),
                Some(s) => s.get(11..19).unwrap_or(&s).to_string(),
                None => String::new(),
            }
        }

        _ => param_to_string(params, var_name),
    }
}

// ─── ICU helpers ───────────────────────────────────────────────────────────────

fn param_to_string(params: Option<&HashMap<String, Value>>, key: &str) -> String {
    match params.and_then(|p| p.get(key)) {
        Some(Value::String(s)) => s.clone(),
        // An explicit `null` is an intentional blank → empty string.
        Some(Value::Null) => String::new(),
        Some(v) => value_to_string(v),
        // Param NOT provided at all: leave the placeholder INTACT (`{key}`) rather
        // than silently substituting empty. This makes a forgotten param visible
        // instead of producing "Bienvenue,  !", and lets a second interpolation
        // phase (server `t()` then client `.replace('{name}', …)`) still fill it.
        None => format!("{{{key}}}"),
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() { i.to_string() }
            else if let Some(f) = n.as_f64() { f.to_string() }
            else { n.to_string() }
        }
        Value::Bool(b) => b.to_string(),
        _ => v.to_string(),
    }
}

fn value_to_number(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn format_number(n: f64) -> String {
    if n == n.floor() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Replace `#` with `replacement`, but ONLY at the top brace level. A `#` inside
/// a nested `{…}` belongs to an inner plural/sub-message and must keep ITS own
/// count, not receive this plural's — otherwise nested plurals cross-contaminate
/// (RO3).
fn replace_hash_top_level(s: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(s.len() + replacement.len());
    let mut depth = 0i32;
    let mut it = s.char_indices().peekable();
    while let Some((_, ch)) = it.next() {
        match ch {
            // Preserve ICU-quoted spans verbatim so a quoted `'#'` stays literal
            // (format_segment decodes it later) and quoted braces don't shift depth.
            '\'' => {
                out.push('\'');
                match it.peek().map(|(_, c)| *c) {
                    Some('\'') => {
                        out.push('\'');
                        it.next();
                    }
                    Some('{') | Some('}') | Some('#') => {
                        while let Some((_, c)) = it.next() {
                            out.push(c);
                            if c == '\'' {
                                if it.peek().map(|(_, c)| *c) == Some('\'') {
                                    out.push('\'');
                                    it.next();
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            '{' => {
                depth += 1;
                out.push(ch);
            }
            '}' => {
                depth -= 1;
                out.push(ch);
            }
            '#' if depth == 0 => out.push_str(replacement),
            _ => out.push(ch),
        }
    }
    out
}

fn format_number_icu(n: f64, style: &str) -> String {
    match style {
        "" | "decimal" => format_number(n),
        "integer" => format!("{}", n as i64),
        "percent" => {
            // Preserve fractional precision (0.125 -> "12.5%", not the old
            // integer-truncated "13%") while killing f64 drift by rounding to 4
            // decimals (audit 2026-06-13). Full ICU parity needs ICU4X.
            let pct = ((n * 100.0) * 10_000.0).round() / 10_000.0;
            format!("{}%", format_number(pct))
        }
        s if s.starts_with("currency/") => {
            let currency = &s["currency/".len()..];
            // Simplified currency: value + symbol. Full locale-aware formatting
            // would need ICU4X. This is correct in value, just not locale-decorated.
            format!("{:.2} {}", n, currency.to_uppercase())
        }
        _ => format_number(n),
    }
}

/// Parse `key {value} key2 {value2}` option blocks. Iterates by char (never
/// `byte as char`) so non-ASCII option keys/values can't land a slice mid-UTF-8
/// and panic (RO6).
fn parse_options(input: &str) -> HashMap<&str, String> {
    let source = input.trim();
    let mut result = HashMap::new();
    let chars: Vec<(usize, char)> = source.char_indices().collect();
    let mut idx = 0;

    while idx < chars.len() {
        // Skip whitespace
        while idx < chars.len() && chars[idx].1.is_whitespace() {
            idx += 1;
        }
        if idx >= chars.len() {
            break;
        }

        let key_start = chars[idx].0;

        // Skip the `offset:N` directive (require the colon so a key literally
        // named `offset` is NOT swallowed).
        if source[key_start..].starts_with("offset:") {
            while idx < chars.len() && !chars[idx].1.is_whitespace() && chars[idx].1 != '{' {
                idx += 1;
            }
            continue;
        }

        // Read key: up to the next whitespace or '{'.
        while idx < chars.len() && !chars[idx].1.is_whitespace() && chars[idx].1 != '{' {
            idx += 1;
        }
        let key_end = if idx < chars.len() { chars[idx].0 } else { source.len() };
        let key = &source[key_start..key_end];

        // Skip whitespace before '{'.
        while idx < chars.len() && chars[idx].1.is_whitespace() {
            idx += 1;
        }
        if idx >= chars.len() || chars[idx].1 != '{' {
            continue;
        }

        let open = chars[idx].0;
        let end = find_matching_brace(source, open);
        if end == usize::MAX {
            break;
        }
        result.insert(key, source[open + 1..end].to_string());
        // Advance the char cursor past the closing brace (a byte index).
        while idx < chars.len() && chars[idx].0 <= end {
            idx += 1;
        }
    }

    result
}

fn parse_offset(input: &str) -> i32 {
    if let Some(pos) = input.find("offset:") {
        let rest = &input[pos + 7..];
        let num_str: String = rest.chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        num_str.parse::<i32>().unwrap_or(0)
    } else {
        0
    }
}

fn split_top_level(input: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut start = 0;

    for (i, ch) in input.char_indices() {
        if ch == '{' { depth += 1; }
        if ch == '}' { depth -= 1; }
        if ch == sep && depth == 0 {
            parts.push(input[start..i].trim());
            start = i + 1;
        }
    }
    if start < input.len() {
        parts.push(input[start..].trim());
    }
    parts
}

fn find_matching_brace(input: &str, open_index: usize) -> usize {
    let mut depth = 0i32;
    let mut it = input[open_index..].char_indices().peekable();
    while let Some((i, ch)) = it.next() {
        match ch {
            // Skip ICU-quoted spans so a quoted `'{'` / `'}'` doesn't move depth.
            '\'' => match it.peek().map(|(_, c)| *c) {
                Some('\'') => {
                    it.next(); // `''` literal
                }
                Some('{') | Some('}') | Some('#') => {
                    // quoted span until the next single `'`
                    while let Some((_, c)) = it.next() {
                        if c == '\'' {
                            if it.peek().map(|(_, c)| *c) == Some('\'') {
                                it.next();
                            } else {
                                break;
                            }
                        }
                    }
                }
                _ => {} // lone `'`
            },
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return open_index + i;
                }
            }
            _ => {}
        }
    }
    usize::MAX
}

// ─── CLDR plural rules (cardinal + ordinal) ────────────────────────────────────
// Covers the top ~30 languages. For uncovered locales, falls back to "other".
// Full CLDR coverage would require the `icu_plurals` crate (~500KB); this
// handles the practical 95% at zero additional binary size.

fn plural_category(n: f64, locale: &str, ordinal: bool) -> &'static str {
    let lang = locale.split('-').next().unwrap_or(locale).split('_').next().unwrap_or(locale);
    let abs_n = n.abs();
    let i = abs_n as u64; // integer part
    let v = if abs_n == abs_n.floor() { 0 } else { // number of visible fraction digits
        let s = format!("{}", abs_n);
        s.find('.').map(|p| s.len() - p - 1).unwrap_or(0)
    };

    if ordinal {
        return plural_ordinal(i, lang);
    }

    match lang {
        // One = 1 (integer, no visible fraction)
        "en" | "de" | "nl" | "sv" | "da" | "no" | "nb" | "nn" | "it" | "es" | "el"
        | "fi" | "he" | "hu" | "tr" | "bg" | "ca" | "et" | "gl" | "hi" | "sw" => {
            if i == 1 && v == 0 { "one" } else { "other" }
        }
        // French + Portuguese: one = 0 or 1. (Region is stripped above, so `pt`
        // covers pt-BR and generic pt — both CLDR `one = 0..1`. RO5: the old
        // `"pt-BR"` arm was dead code since `lang` never carries a region.)
        "fr" | "pt" => {
            if i == 0 || i == 1 { "one" } else { "other" }
        }
        // Arabic: zero, one, two, few, many, other
        "ar" => {
            if abs_n == 0.0 { "zero" }
            else if i == 1 && v == 0 { "one" }
            else if i == 2 && v == 0 { "two" }
            else {
                let mod100 = i % 100;
                if (3..=10).contains(&mod100) { "few" }
                else if (11..=99).contains(&mod100) { "many" }
                else { "other" }
            }
        }
        // Polish: one=1, few=2-4 (mod 10, not 12-14), many=rest
        "pl" => {
            if i == 1 && v == 0 { "one" }
            else {
                let mod10 = i % 10;
                let mod100 = i % 100;
                if v == 0 && (2..=4).contains(&mod10) && !(12..=14).contains(&mod100) { "few" }
                else if v == 0 && (mod10 == 0 || mod10 == 1 || (5..=9).contains(&mod10) || (12..=14).contains(&mod100)) { "many" }
                else { "other" }
            }
        }
        // Russian/Ukrainian: one=1, few=2-4 (mod 10, not 12-14), many=rest
        "ru" | "uk" => {
            let mod10 = i % 10;
            let mod100 = i % 100;
            if v == 0 && mod10 == 1 && mod100 != 11 { "one" }
            else if v == 0 && (2..=4).contains(&mod10) && !(12..=14).contains(&mod100) { "few" }
            else if v == 0 && (mod10 == 0 || (5..=9).contains(&mod10) || (11..=14).contains(&mod100)) { "many" }
            else { "other" }
        }
        // Czech/Slovak
        "cs" | "sk" => {
            if i == 1 && v == 0 { "one" }
            else if (2..=4).contains(&i) && v == 0 { "few" }
            else if v != 0 { "many" }
            else { "other" }
        }
        // Japanese, Chinese, Korean, Thai, Vietnamese: no plural forms
        "ja" | "zh" | "ko" | "th" | "vi" | "id" | "ms" => "other",

        _ => {
            // Default: English-like (one/other)
            if i == 1 && v == 0 { "one" } else { "other" }
        }
    }
}

fn plural_ordinal(n: u64, lang: &str) -> &'static str {
    match lang {
        "en" => {
            let mod10 = n % 10;
            let mod100 = n % 100;
            if mod10 == 1 && mod100 != 11 { "one" }
            else if mod10 == 2 && mod100 != 12 { "two" }
            else if mod10 == 3 && mod100 != 13 { "few" }
            else { "other" }
        }
        _ => "other",
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_catalogs() -> Catalogs {
        let mut catalogs = Catalogs::new();
        let mut en = HashMap::new();
        en.insert("greet".to_string(), "Hello {name}".to_string());
        en.insert("items".to_string(), "{count, plural, =0 {No items} one {# item} other {# items}}".to_string());
        en.insert("gender".to_string(), "{g, select, male {He} female {She} other {They}}".to_string());
        en.insert("ordinal".to_string(), "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}".to_string());
        catalogs.insert("en".to_string(), en);

        let mut fr = HashMap::new();
        fr.insert("greet".to_string(), "Bonjour {name}".to_string());
        fr.insert("items".to_string(), "{count, plural, =0 {Aucun élément} one {# élément} other {# éléments}}".to_string());
        catalogs.insert("fr".to_string(), fr);

        catalogs
    }

    #[test]
    fn translates_simple_placeholder() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        let mut params = HashMap::new();
        params.insert("name".to_string(), Value::String("Kaen".to_string()));
        assert_eq!(translate(&catalogs, "greet", Some(&params), &chain, None), "Hello Kaen");
    }

    #[test]
    fn percent_preserves_fractional_precision() {
        // 0.125 must render "12.5%", not the old integer-truncated "13%"
        // (audit 2026-06-13). Whole percents stay clean; f64 drift is killed.
        assert_eq!(format_number_icu(0.125, "percent"), "12.5%");
        assert_eq!(format_number_icu(0.13, "percent"), "13%");
        assert_eq!(format_number_icu(0.1, "percent"), "10%");
        assert_eq!(format_number_icu(1.0, "percent"), "100%");
    }

    #[test]
    fn missing_param_leaves_placeholder_intact() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        // No params at all → `{name}` is preserved (not replaced with empty), so a
        // 2nd interpolation phase can fill it and a forgotten param stays visible.
        assert_eq!(translate(&catalogs, "greet", None, &chain, None), "Hello {name}");
        // Params present but missing the referenced key → same.
        let mut other = HashMap::new();
        other.insert("other".to_string(), Value::String("x".to_string()));
        assert_eq!(
            translate(&catalogs, "greet", Some(&other), &chain, None),
            "Hello {name}"
        );
    }

    #[test]
    fn translates_plural_zero() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        let mut params = HashMap::new();
        params.insert("count".to_string(), Value::Number(0.into()));
        assert_eq!(translate(&catalogs, "items", Some(&params), &chain, None), "No items");
    }

    #[test]
    fn translates_plural_one() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        let mut params = HashMap::new();
        params.insert("count".to_string(), Value::Number(1.into()));
        assert_eq!(translate(&catalogs, "items", Some(&params), &chain, None), "1 item");
    }

    #[test]
    fn translates_plural_many() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        let mut params = HashMap::new();
        params.insert("count".to_string(), Value::Number(42.into()));
        assert_eq!(translate(&catalogs, "items", Some(&params), &chain, None), "42 items");
    }

    #[test]
    fn translates_select() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        let mut params = HashMap::new();
        params.insert("g".to_string(), Value::String("female".to_string()));
        assert_eq!(translate(&catalogs, "gender", Some(&params), &chain, None), "She");
    }

    #[test]
    fn translates_selectordinal_english() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        for (n, expected) in [(1, "1st"), (2, "2nd"), (3, "3rd"), (4, "4th"), (11, "11th"), (21, "21st")] {
            let mut params = HashMap::new();
            params.insert("n".to_string(), Value::Number(n.into()));
            assert_eq!(
                translate(&catalogs, "ordinal", Some(&params), &chain, None),
                expected,
                "ordinal for {}",
                n,
            );
        }
    }

    #[test]
    fn translates_french_plural() {
        let catalogs = sample_catalogs();
        let chain = vec!["fr".to_string()];
        let mut params = HashMap::new();
        params.insert("count".to_string(), Value::Number(0.into()));
        assert_eq!(translate(&catalogs, "items", Some(&params), &chain, None), "Aucun élément");

        params.insert("count".to_string(), Value::Number(5.into()));
        assert_eq!(translate(&catalogs, "items", Some(&params), &chain, None), "5 éléments");
    }

    #[test]
    fn null_param_renders_empty() {
        let catalogs = sample_catalogs();
        let chain = vec!["en".to_string()];
        let mut params = HashMap::new();
        params.insert("name".to_string(), Value::Null);
        assert_eq!(translate(&catalogs, "greet", Some(&params), &chain, None), "Hello ");
    }

    #[test]
    fn falls_back_to_default() {
        let catalogs = sample_catalogs();
        let chain = vec!["es".to_string()];
        assert_eq!(translate(&catalogs, "missing", None, &chain, Some("N/A")), "N/A");
    }

    #[test]
    fn has_key_works() {
        let catalogs = sample_catalogs();
        assert!(has_key(&catalogs, "greet", &["fr".to_string()]));
        assert!(!has_key(&catalogs, "missing", &["fr".to_string(), "en".to_string()]));
    }

    // ─── audit regressions (RO1-RO5) ───────────────────────────────────────────

    fn cat(locale: &str, pairs: &[(&str, &str)]) -> Catalogs {
        let mut c = Catalogs::new();
        let mut m = HashMap::new();
        for (k, v) in pairs {
            m.insert(k.to_string(), v.to_string());
        }
        c.insert(locale.to_string(), m);
        c
    }

    fn one(k: &str, v: Value) -> HashMap<String, Value> {
        let mut p = HashMap::new();
        p.insert(k.to_string(), v);
        p
    }

    #[test]
    fn ro2_icu_escaping() {
        let c = cat(
            "en",
            &[
                ("lit", "use '{' and '}' literally"),
                ("apos", "o''clock"),
                ("mix", "'{'{name}'}'"),
            ],
        );
        let chain = vec!["en".to_string()];
        assert_eq!(translate(&c, "lit", None, &chain, None), "use { and } literally");
        assert_eq!(translate(&c, "apos", None, &chain, None), "o'clock");
        assert_eq!(
            translate(&c, "mix", Some(&one("name", Value::String("X".into()))), &chain, None),
            "{X}"
        );
    }

    #[test]
    fn ro1_missing_param_keeps_plural_and_select_intact() {
        let c = cat(
            "en",
            &[
                ("items", "{count, plural, one {# item} other {# items}}"),
                ("g", "{gender, select, male {He} other {They}}"),
            ],
        );
        let chain = vec!["en".to_string()];
        assert_eq!(
            translate(&c, "items", None, &chain, None),
            "{count, plural, one {# item} other {# items}}"
        );
        assert_eq!(
            translate(&c, "g", None, &chain, None),
            "{gender, select, male {He} other {They}}"
        );
    }

    #[test]
    fn ro4_kind_keyword_in_option_body() {
        let c = cat("en", &[("k", "{x, select, a {pick select here} other {none}}")]);
        let chain = vec!["en".to_string()];
        assert_eq!(
            translate(&c, "k", Some(&one("x", Value::String("a".into()))), &chain, None),
            "pick select here"
        );
    }

    #[test]
    fn ro3_nested_plural_hash_not_cross_replaced() {
        let c = cat("en", &[("n", "{a, plural, other {{b, plural, other {#}}}}")]);
        let chain = vec!["en".to_string()];
        let mut p = HashMap::new();
        p.insert("a".to_string(), Value::Number(5.into()));
        p.insert("b".to_string(), Value::Number(2.into()));
        // Inner `#` must show the INNER count (2), not the outer (5).
        assert_eq!(translate(&c, "n", Some(&p), &chain, None), "2");
    }

    #[test]
    fn ro7_date_time_slices_iso_string() {
        let c = cat("en", &[("d", "{when, date}"), ("t", "{when, time}")]);
        let chain = vec!["en".to_string()];
        // A JS `Date` serialises to an ISO string via `JSON.stringify`; the engine
        // must slice the date/time portion, not echo the whole ISO string.
        let iso = Value::String("2026-06-10T12:34:56.000Z".into());
        assert_eq!(
            translate(&c, "d", Some(&one("when", iso.clone())), &chain, None),
            "2026-06-10"
        );
        assert_eq!(
            translate(&c, "t", Some(&one("when", iso)), &chain, None),
            "12:34:56"
        );
    }

    #[test]
    fn ro5_portuguese_plural_one_is_zero_or_one() {
        let c = cat("pt", &[("items", "{count, plural, one {# item} other {# itens}}")]);
        let chain = vec!["pt".to_string()];
        assert_eq!(
            translate(&c, "items", Some(&one("count", Value::Number(0.into()))), &chain, None),
            "0 item"
        );
        assert_eq!(
            translate(&c, "items", Some(&one("count", Value::Number(2.into()))), &chain, None),
            "2 itens"
        );
    }
}
