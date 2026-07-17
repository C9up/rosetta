use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::skeleton::{validate_date_style, validate_number_style};

const MAX_NESTING_DEPTH: usize = 100;
const MAX_AST_NODES: usize = 100_000;

#[derive(Default)]
struct ParseState {
    nodes: usize,
}

impl ParseState {
    fn push(&mut self, nodes: &mut Vec<MessageNode>, node: MessageNode) -> Result<(), String> {
        self.nodes += 1;
        if self.nodes > MAX_AST_NODES {
            return Err(format!(
                "ICU message exceeds the {MAX_AST_NODES} AST node limit"
            ));
        }
        nodes.push(node);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessageNode {
    Text {
        value: String,
    },
    Argument {
        name: String,
    },
    Select {
        name: String,
        options: BTreeMap<String, Vec<MessageNode>>,
    },
    Plural {
        name: String,
        options: BTreeMap<String, Vec<MessageNode>>,
        offset: f64,
        ordinal: bool,
    },
    Number {
        name: String,
        style: String,
    },
    DateTime {
        name: String,
        style: String,
        kind: String,
    },
    Pound,
}

pub fn parse_message(message: &str) -> Result<Vec<MessageNode>, String> {
    parse_segment(message, 0, &mut ParseState::default())
}

fn parse_segment(
    source: &str,
    depth: usize,
    state: &mut ParseState,
) -> Result<Vec<MessageNode>, String> {
    if depth > MAX_NESTING_DEPTH {
        return Err(format!(
            "ICU message exceeds {MAX_NESTING_DEPTH} nesting levels"
        ));
    }

    let mut nodes = Vec::new();
    let mut text = String::new();
    let mut index = 0;
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        match ch {
            '\'' => {
                let (quoted, next) = consume_quote(source, index);
                text.push_str(&quoted);
                index = next;
            }
            '{' => {
                flush_text(&mut nodes, &mut text, state)?;
                let end = find_matching_brace(source, index)
                    .ok_or_else(|| "Unclosed ICU argument".to_string())?;
                let node = parse_argument(&source[index + 1..end], depth + 1, state)?;
                state.push(&mut nodes, node)?;
                index = end + 1;
            }
            '}' => return Err("Unexpected ICU closing brace".to_string()),
            '#' => {
                flush_text(&mut nodes, &mut text, state)?;
                state.push(&mut nodes, MessageNode::Pound)?;
                index += 1;
            }
            _ => {
                text.push(ch);
                index += ch.len_utf8();
            }
        }
    }
    flush_text(&mut nodes, &mut text, state)?;
    Ok(nodes)
}

fn parse_argument(
    content: &str,
    depth: usize,
    state: &mut ParseState,
) -> Result<MessageNode, String> {
    let parts = split_top_level(content, ',');
    let name = parts
        .first()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .ok_or_else(|| "Empty ICU argument".to_string())?
        .to_string();
    if parts.len() == 1 {
        return Ok(MessageNode::Argument { name });
    }

    let kind = parts[1].trim();
    let style = parts[2..].join(",").trim().to_string();
    match kind {
        "select" => {
            let (raw_options, _) = parse_options(&style, false)?;
            let options = parse_option_nodes(raw_options, depth, state)?;
            require_other(&options, "select")?;
            Ok(MessageNode::Select { name, options })
        }
        "plural" | "selectordinal" => {
            let (raw_options, offset) = parse_options(&style, true)?;
            let options = parse_option_nodes(raw_options, depth, state)?;
            require_other(&options, kind)?;
            Ok(MessageNode::Plural {
                name,
                options,
                offset,
                ordinal: kind == "selectordinal",
            })
        }
        "number" => {
            validate_number_style(&style)?;
            Ok(MessageNode::Number { name, style })
        }
        "date" | "time" => {
            validate_date_style(&style, kind)?;
            Ok(MessageNode::DateTime {
                name,
                style,
                kind: kind.to_string(),
            })
        }
        _ => Err(format!("Unsupported ICU argument type '{kind}'")),
    }
}

fn parse_option_nodes(
    options: BTreeMap<String, String>,
    depth: usize,
    state: &mut ParseState,
) -> Result<BTreeMap<String, Vec<MessageNode>>, String> {
    options
        .into_iter()
        .map(|(key, value)| Ok((key, parse_segment(&value, depth, state)?)))
        .collect()
}

fn require_other(options: &BTreeMap<String, Vec<MessageNode>>, kind: &str) -> Result<(), String> {
    if options.contains_key("other") {
        Ok(())
    } else {
        Err(format!("ICU {kind} arguments require an 'other' option"))
    }
}

fn parse_options(
    source: &str,
    allow_offset: bool,
) -> Result<(BTreeMap<String, String>, f64), String> {
    let mut options = BTreeMap::new();
    let mut offset = 0.0;
    let mut saw_offset = false;
    let mut saw_option = false;
    let mut index = 0;
    while index < source.len() {
        index = skip_whitespace(source, index);
        if index >= source.len() {
            break;
        }
        if allow_offset && source[index..].starts_with("offset:") {
            if saw_offset {
                return Err("Duplicate ICU plural offset".to_string());
            }
            if saw_option {
                return Err("ICU plural offset must precede all options".to_string());
            }
            saw_offset = true;
            index += "offset:".len();
            let start = index;
            while index < source.len() {
                let ch = source[index..].chars().next().unwrap();
                if !(ch.is_ascii_digit() || matches!(ch, '-' | '+' | '.')) {
                    break;
                }
                index += ch.len_utf8();
            }
            offset = source[start..index]
                .parse::<f64>()
                .map_err(|_| "Invalid ICU plural offset".to_string())?;
            if !offset.is_finite() || offset < 0.0 {
                return Err("ICU plural offset must be a non-negative finite number".to_string());
            }
            if index < source.len()
                && !source[index..]
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace)
            {
                return Err("Invalid ICU plural offset delimiter".to_string());
            }
            continue;
        }

        let key_start = index;
        while index < source.len() {
            let ch = source[index..].chars().next().unwrap();
            if ch.is_whitespace() || ch == '{' {
                break;
            }
            index += ch.len_utf8();
        }
        let key = source[key_start..index].trim();
        index = skip_whitespace(source, index);
        if key.is_empty() || !source[index..].starts_with('{') {
            return Err(format!(
                "Invalid ICU option list near '{}'",
                &source[index..]
            ));
        }
        let end = find_matching_brace(source, index)
            .ok_or_else(|| "Unclosed ICU option body".to_string())?;
        if options
            .insert(key.to_string(), source[index + 1..end].to_string())
            .is_some()
        {
            return Err(format!("Duplicate ICU option '{key}'"));
        }
        saw_option = true;
        index = end + 1;
    }
    Ok((options, offset))
}

fn split_top_level(source: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    let mut index = 0;
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        if ch == '\'' {
            index = consume_quote(source, index).1;
            continue;
        }
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ if ch == separator && depth == 0 => {
                parts.push(source[start..index].trim());
                start = index + ch.len_utf8();
            }
            _ => {}
        }
        index += ch.len_utf8();
    }
    parts.push(source[start..].trim());
    parts
}

fn find_matching_brace(source: &str, start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = start;
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        if ch == '\'' {
            index = consume_quote(source, index).1;
            continue;
        }
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
        index += ch.len_utf8();
    }
    None
}

fn consume_quote(source: &str, start: usize) -> (String, usize) {
    let after = start + 1;
    if source[after..].starts_with('\'') {
        return ("'".to_string(), after + 1);
    }
    let next = source[after..].chars().next();
    if !matches!(next, Some('{') | Some('}') | Some('#')) {
        return ("'".to_string(), after);
    }

    let mut output = String::new();
    let mut index = after;
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        if ch != '\'' {
            output.push(ch);
            index += ch.len_utf8();
            continue;
        }
        let next_index = index + 1;
        if source[next_index..].starts_with('\'') {
            output.push('\'');
            index = next_index + 1;
            continue;
        }
        return (output, next_index);
    }
    (output, source.len())
}

fn skip_whitespace(source: &str, mut index: usize) -> usize {
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        if !ch.is_whitespace() {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

fn flush_text(
    nodes: &mut Vec<MessageNode>,
    text: &mut String,
    state: &mut ParseState,
) -> Result<(), String> {
    if !text.is_empty() {
        state.push(
            nodes,
            MessageNode::Text {
                value: std::mem::take(text),
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_icu_message_to_ast() {
        let ast = parse_message(
            "{gender, select, female {{count, plural, one {# item} other {# items}}} other {None}}",
        )
        .unwrap();
        assert!(matches!(ast.first(), Some(MessageNode::Select { .. })));
    }

    #[test]
    fn rejects_missing_other_branch() {
        assert!(parse_message("{count, plural, one {one}}")
            .unwrap_err()
            .contains("other"));
    }

    #[test]
    fn decodes_icu_apostrophe_quotes() {
        let ast = parse_message("This '{isn''t}' obvious").unwrap();
        assert_eq!(
            ast,
            vec![MessageNode::Text {
                value: "This {isn't} obvious".to_string()
            }]
        );
    }

    #[test]
    fn rejects_duplicate_options_and_invalid_offsets() {
        assert!(parse_message("{n, plural, one {a} one {b} other {c}}")
            .unwrap_err()
            .contains("Duplicate ICU option"));
        assert!(parse_message("{n, plural, one {a} offset:1 other {c}}")
            .unwrap_err()
            .contains("must precede"));
        assert!(parse_message("{n, plural, offset:-1 other {c}}")
            .unwrap_err()
            .contains("non-negative"));
    }

    #[test]
    fn parser_never_panics_on_deterministic_malformed_inputs() {
        let alphabet = b"{}#',: abcdefghijklmnopqrstuvwxyz0123456789+-_.";
        let mut seed = 0x6a09_e667_f3bc_c909_u64;
        for length in 0..512 {
            let mut input = String::with_capacity(length);
            for _ in 0..length {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                input.push(alphabet[(seed as usize) % alphabet.len()] as char);
            }
            let first = std::panic::catch_unwind(|| parse_message(&input));
            assert!(first.is_ok(), "parser panicked for {input:?}");
            assert_eq!(first.unwrap(), parse_message(&input));
        }
    }
}
