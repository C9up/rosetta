use serde_json::{Map, Number, Value};

const DANGEROUS_KEYS: [&str; 3] = ["__proto__", "prototype", "constructor"];
const MAX_CATALOG_DEPTH: usize = 100;
const MAX_CATALOG_KEYS: usize = 100_000;

pub fn parse_catalog(input: &str, format: &str) -> Result<Value, String> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let value = match format {
        "json" => serde_json::from_str(input.trim()).map_err(|error| error.to_string())?,
        "yaml" | "yml" => parse_yaml(input)?,
        _ => return Err(format!("Unsupported catalog format '{format}'")),
    };
    let mut key_count = 0;
    validate_catalog(&value, 0, &mut key_count)?;
    Ok(value)
}

fn validate_catalog(value: &Value, depth: usize, key_count: &mut usize) -> Result<(), String> {
    if depth > MAX_CATALOG_DEPTH {
        return Err(format!(
            "Translation catalog exceeds {MAX_CATALOG_DEPTH} nesting levels"
        ));
    }
    let object = value
        .as_object()
        .ok_or_else(|| "Translation catalog root must be an object".to_string())?;
    for (key, child) in object {
        *key_count += 1;
        if *key_count > MAX_CATALOG_KEYS {
            return Err(format!(
                "Translation catalog exceeds the {MAX_CATALOG_KEYS} key limit"
            ));
        }
        assert_safe_key(key)?;
        match child {
            Value::Object(_) => validate_catalog(child, depth + 1, key_count)?,
            Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => {}
            Value::Array(_) => {
                return Err(format!(
                    "Unsupported catalog value for key '{key}': arrays are not allowed"
                ));
            }
        }
    }
    Ok(())
}

fn parse_yaml(input: &str) -> Result<Value, String> {
    let lines: Vec<&str> = input.lines().collect();
    let mut root = Map::new();
    let mut parents: Vec<(usize, String)> = Vec::new();
    let mut previous_indent = 0usize;
    let mut previous_was_mapping = false;
    let mut index = 0usize;

    while index < lines.len() {
        let raw_line = lines[index];
        let line_number = index + 1;
        index += 1;
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || matches!(trimmed, "---" | "...") {
            continue;
        }

        let indent = raw_line.len() - raw_line.trim_start_matches(' ').len();
        if raw_line[..indent].contains('\t') || raw_line[indent..].starts_with('\t') {
            return Err(format!(
                "Tabs are not valid YAML indentation on line {line_number}"
            ));
        }
        if parents.is_empty() && indent != 0 {
            return Err(format!(
                "Top-level YAML keys must not be indented on line {line_number}"
            ));
        }
        if indent > previous_indent && !previous_was_mapping && line_number > 1 {
            return Err(format!("Unexpected YAML indentation on line {line_number}"));
        }

        while parents.last().is_some_and(|(level, _)| indent <= *level) {
            parents.pop();
        }
        if parents.len() >= MAX_CATALOG_DEPTH {
            return Err(format!(
                "Translation catalog exceeds {MAX_CATALOG_DEPTH} nesting levels"
            ));
        }

        let content = &raw_line[indent..];
        let delimiter = find_mapping_delimiter(content)
            .ok_or_else(|| format!("Unsupported YAML syntax on line {line_number}: {raw_line}"))?;
        let key = parse_key(content[..delimiter].trim(), line_number)?;
        assert_safe_key(&key)?;
        let raw_value = content[delimiter + 1..].trim();

        if is_unsupported_construct(raw_value) {
            return Err(format!(
                "Unsupported YAML construct for key '{key}'. Rosetta locale files accept mappings and scalar messages only."
            ));
        }

        if matches!(raw_value, "|" | ">" | "|-" | ">-" | "|+" | ">+") {
            let folded = raw_value.starts_with('>');
            let (value, next) = parse_block_scalar(&lines, index, indent, folded);
            insert_value(&mut root, &parents, key, Value::String(value))?;
            index = next;
            previous_indent = indent;
            previous_was_mapping = false;
            continue;
        }

        if raw_value.is_empty() {
            insert_value(&mut root, &parents, key.clone(), Value::Object(Map::new()))?;
            parents.push((indent, key));
            previous_indent = indent;
            previous_was_mapping = true;
            continue;
        }

        let scalar = parse_scalar(strip_inline_comment(raw_value), line_number)?;
        insert_value(&mut root, &parents, key, scalar)?;
        previous_indent = indent;
        previous_was_mapping = false;
    }

    Ok(Value::Object(root))
}

fn find_mapping_delimiter(line: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quote == Some('"') && ch == '\\' {
            escaped = true;
            continue;
        }
        if matches!(ch, '\'' | '"') {
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(ch);
            }
            continue;
        }
        if ch == ':' && quote.is_none() {
            let next = line[index + 1..].chars().next();
            if next.is_none() || next.is_some_and(char::is_whitespace) {
                return Some(index);
            }
        }
    }
    None
}

fn parse_key(raw: &str, line: usize) -> Result<String, String> {
    if raw.is_empty() {
        return Err(format!("Empty YAML mapping key on line {line}"));
    }
    match parse_scalar(raw, line)? {
        Value::String(value) if !value.is_empty() => Ok(value),
        _ => Err(format!("YAML mapping keys must be strings on line {line}")),
    }
}

fn is_unsupported_construct(value: &str) -> bool {
    value.starts_with('&')
        || value.starts_with('*')
        || value.starts_with('!')
        || value.starts_with('[')
        || value.starts_with('{')
        || value.starts_with("<<:")
}

fn parse_scalar(raw: &str, line: usize) -> Result<Value, String> {
    if raw.starts_with('"') {
        if !raw.ends_with('"') || raw.len() == 1 {
            return Err(format!("Unclosed double-quoted YAML scalar on line {line}"));
        }
        return serde_json::from_str::<String>(raw)
            .map(Value::String)
            .map_err(|_| format!("Invalid double-quoted YAML scalar on line {line}"));
    }
    if raw.starts_with('\'') {
        if !raw.ends_with('\'') || raw.len() == 1 {
            return Err(format!("Unclosed single-quoted YAML scalar on line {line}"));
        }
        return Ok(Value::String(raw[1..raw.len() - 1].replace("''", "'")));
    }
    if raw.ends_with('\'') || raw.ends_with('"') {
        return Err(format!("Unexpected quote in YAML scalar on line {line}"));
    }

    match raw.to_ascii_lowercase().as_str() {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        "null" | "~" => return Ok(Value::Null),
        _ => {}
    }
    if is_yaml_number(raw) {
        let number = raw
            .parse::<Number>()
            .map_err(|_| format!("Invalid YAML number on line {line}"))?;
        return Ok(Value::Number(number));
    }
    Ok(Value::String(raw.to_string()))
}

fn is_yaml_number(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = usize::from(matches!(bytes[0], b'+' | b'-'));
    let mut integer_digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        integer_digits += 1;
        index += 1;
    }
    if integer_digits == 0 {
        return false;
    }
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
    }
    if index < bytes.len() && matches!(bytes[index], b'e' | b'E') {
        index += 1;
        if index < bytes.len() && matches!(bytes[index], b'+' | b'-') {
            index += 1;
        }
        let exponent_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if exponent_start == index {
            return false;
        }
    }
    index == bytes.len()
}

fn strip_inline_comment(value: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    let mut previous = None;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            previous = Some(ch);
            continue;
        }
        if quote == Some('"') && ch == '\\' {
            escaped = true;
            previous = Some(ch);
            continue;
        }
        if matches!(ch, '\'' | '"') {
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(ch);
            }
        } else if ch == '#' && quote.is_none() && previous.is_some_and(char::is_whitespace) {
            return value[..index].trim_end();
        }
        previous = Some(ch);
    }
    value
}

fn parse_block_scalar(
    lines: &[&str],
    start: usize,
    parent_indent: usize,
    folded: bool,
) -> (String, usize) {
    let mut values = Vec::new();
    let mut index = start;
    let mut block_indent = None;
    while index < lines.len() {
        let line = lines[index];
        let line_indent = line.len() - line.trim_start_matches(' ').len();
        if !line.trim().is_empty() && line_indent <= parent_indent {
            break;
        }
        if !line.trim().is_empty() && block_indent.is_none() {
            block_indent = Some(line_indent);
        }
        let content_indent = block_indent.unwrap_or(parent_indent + 2);
        values.push(line.get(content_indent..).unwrap_or(""));
        index += 1;
    }
    while values.last() == Some(&"") {
        values.pop();
    }
    let value = if folded {
        fold_paragraphs(&values)
    } else {
        values.join("\n")
    };
    (value, index)
}

fn fold_paragraphs(lines: &[&str]) -> String {
    let mut output = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            if line.is_empty() || lines[index - 1].is_empty() {
                output.push('\n');
            } else {
                output.push(' ');
            }
        }
        output.push_str(line);
    }
    output
}

fn insert_value(
    root: &mut Map<String, Value>,
    parents: &[(usize, String)],
    key: String,
    value: Value,
) -> Result<(), String> {
    let mut target = root;
    for (_, parent) in parents {
        target = target
            .get_mut(parent)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| format!("Invalid YAML parent mapping '{parent}'"))?;
    }
    if target.contains_key(&key) {
        return Err(format!("Duplicate YAML key '{key}'"));
    }
    target.insert(key, value);
    Ok(())
}

fn assert_safe_key(key: &str) -> Result<(), String> {
    if DANGEROUS_KEYS.contains(&key) {
        Err(format!("Unsafe translation key '{key}'"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::parse_catalog;
    use serde_json::json;

    #[test]
    fn parses_nested_yaml_catalogs() {
        let parsed = parse_catalog(
            "app:\n  title: My App\n  enabled: true\n  count: 2\nmessage: 'O''Brien'",
            "yaml",
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({
                "app": { "title": "My App", "enabled": true, "count": 2 },
                "message": "O'Brien"
            })
        );
    }

    #[test]
    fn parses_yaml_block_scalars() {
        let parsed = parse_catalog(
            "literal: |\n  first\n  second\nfolded: >\n  first\n  second\n\n  third",
            "yaml",
        )
        .unwrap();
        assert_eq!(parsed["literal"], "first\nsecond");
        assert_eq!(parsed["folded"], "first second\n\nthird");
    }

    #[test]
    fn trims_utf8_bom_from_json_and_yaml_catalogs() {
        assert_eq!(
            parse_catalog("\u{feff} {\"hello\":\"world\"}", "json").unwrap(),
            json!({ "hello": "world" })
        );
        assert_eq!(
            parse_catalog("\u{feff}hello: world", "yaml").unwrap(),
            json!({ "hello": "world" })
        );
    }

    #[test]
    fn rejects_unsafe_and_collection_values() {
        assert!(parse_catalog("__proto__: value", "yaml").is_err());
        assert!(parse_catalog("items: [one, two]", "yaml").is_err());
        assert!(parse_catalog(r#"{"items":["one"]}"#, "json").is_err());
    }

    #[test]
    fn rejects_excessive_catalog_depth() {
        let mut input = String::new();
        for depth in 0..102 {
            input.push_str(&"  ".repeat(depth));
            input.push_str(&format!("level{depth}:\n"));
        }
        assert!(parse_catalog(&input, "yaml")
            .unwrap_err()
            .contains("nesting levels"));
    }

    #[test]
    fn parser_never_panics_on_deterministic_malformed_inputs() {
        let alphabet = b"{}[]#&*!':, abcdefghijklmnopqrstuvwxyz0123456789+-_.\n\t";
        let mut seed = 0xbb67_ae85_84ca_a73b_u64;
        for length in 0..512 {
            let mut input = String::with_capacity(length);
            for _ in 0..length {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                input.push(alphabet[(seed as usize) % alphabet.len()] as char);
            }
            for format in ["json", "yaml"] {
                let first = std::panic::catch_unwind(|| parse_catalog(&input, format));
                assert!(first.is_ok(), "parser panicked for {format}: {input:?}");
                assert_eq!(first.unwrap(), parse_catalog(&input, format));
            }
        }
    }
}
