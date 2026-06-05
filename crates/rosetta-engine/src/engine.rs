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
    if !message.contains('{') {
        return message.to_string();
    }
    format_segment(message, params, locale)
}

fn format_segment(segment: &str, params: Option<&HashMap<String, Value>>, locale: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    let mut i = 0;

    // Iterate by byte index but always push full UTF-8 chars. We use byte
    // indexing for brace matching ('{' and '}' are single-byte ASCII) and
    // slice the original &str for everything else — never `byte as char`.
    while i < segment.len() {
        if segment.as_bytes()[i] != b'{' {
            // Find the next '{' or end-of-string, push the whole slice at once.
            let next = segment[i..].find('{').map(|p| i + p).unwrap_or(segment.len());
            out.push_str(&segment[i..next]);
            i = next;
            continue;
        }

        let end = find_matching_brace(segment, i);
        if end == usize::MAX {
            out.push_str(&segment[i..]);
            break;
        }

        let content = segment[i + 1..end].trim();
        out.push_str(&resolve_token(content, params, locale));
        i = end + 1;
    }
    out
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
    // Everything after the type keyword (for option parsing).
    let options_start = content.find(kind).unwrap_or(0) + kind.len();
    let options_raw = if options_start < content.len() {
        content[options_start..].trim_start_matches(',').trim()
    } else {
        ""
    };

    let raw_value = params.and_then(|p| p.get(var_name));

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
                let replaced = msg.replace('#', &format_number(adjusted));
                return format_segment(&replaced, params, locale);
            }

            // CLDR plural category
            let ordinal = kind == "selectordinal";
            let category = plural_category(adjusted, locale, ordinal);
            let selected = options.get(category)
                .or_else(|| options.get("other"))
                .cloned()
                .unwrap_or_default();
            let replaced = selected.replace('#', &format_number(adjusted));
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
            let s = match raw_value {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => {
                    if let Some(ms) = n.as_f64() {
                        // Epoch millis → ISO
                        let secs = (ms / 1000.0) as i64;
                        let naive = chrono::DateTime::from_timestamp(secs, 0)
                            .map(|dt| dt.to_rfc3339())
                            .unwrap_or_default();
                        if kind == "date" {
                            naive.get(..10).unwrap_or(&naive).to_string()
                        } else {
                            naive.get(11..19).unwrap_or(&naive).to_string()
                        }
                    } else {
                        String::new()
                    }
                }
                _ => String::new(),
            };
            s
        }

        _ => param_to_string(params, var_name),
    }
}

// ─── ICU helpers ───────────────────────────────────────────────────────────────

fn param_to_string(params: Option<&HashMap<String, Value>>, key: &str) -> String {
    match params.and_then(|p| p.get(key)) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => String::new(),
        Some(v) => value_to_string(v),
        None => String::new(),
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

fn format_number_icu(n: f64, style: &str) -> String {
    match style {
        "" | "decimal" => format_number(n),
        "integer" => format!("{}", n as i64),
        "percent" => format!("{}%", (n * 100.0).round() as i64),
        s if s.starts_with("currency/") => {
            let currency = &s["currency/".len()..];
            // Simplified currency: value + symbol. Full locale-aware formatting
            // would need ICU4X. This is correct in value, just not locale-decorated.
            format!("{:.2} {}", n, currency.to_uppercase())
        }
        _ => format_number(n),
    }
}

/// Parse `key {value} key2 {value2}` option blocks.
fn parse_options(input: &str) -> HashMap<&str, String> {
    let source = input.trim();
    let mut result = HashMap::new();
    let bytes = source.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Skip whitespace
        while i < bytes.len() && (bytes[i] as char).is_whitespace() { i += 1; }
        if i >= bytes.len() { break; }

        // Skip "offset:N"
        if source[i..].starts_with("offset") {
            while i < bytes.len() && bytes[i] != b' ' && bytes[i] != b'{' { i += 1; }
            continue;
        }

        // Read key
        let key_start = i;
        while i < bytes.len() && !(bytes[i] as char).is_whitespace() && bytes[i] != b'{' {
            i += 1;
        }
        let key = &source[key_start..i];

        // Skip whitespace before '{'
        while i < bytes.len() && (bytes[i] as char).is_whitespace() { i += 1; }
        if i >= bytes.len() || bytes[i] != b'{' { continue; }

        let end = find_matching_brace(source, i);
        if end == usize::MAX { break; }
        result.insert(key, source[i + 1..end].to_string());
        i = end + 1;
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
    let mut depth = 0;
    for (i, ch) in input[open_index..].char_indices() {
        if ch == '{' { depth += 1; }
        if ch == '}' {
            depth -= 1;
            if depth == 0 { return open_index + i; }
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
        "en" | "de" | "nl" | "sv" | "da" | "no" | "nb" | "nn" | "it" | "es" | "pt" | "el"
        | "fi" | "he" | "hu" | "tr" | "bg" | "ca" | "et" | "gl" | "hi" | "sw" => {
            if i == 1 && v == 0 { "one" } else { "other" }
        }
        // French/Brazilian: one = 0 or 1
        "fr" | "pt-BR" => {
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
}
