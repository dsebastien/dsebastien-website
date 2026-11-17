//! The properties of a note, read and written as text.
//!
//! The publishing logic exists two times, and two YAML libraries never agree
//! on every byte. So both implementations work on lines, with the rules of
//! `documentation/Canonical Form.md`. The TypeScript twin is
//! `apps/plugin/src/publishing/frontmatter.ts`.

/// A note cut in three: the lines of its properties, the text after them, and
/// its line end.
struct Parts {
    /// The lines between the two `---` lines, without their line end.
    properties: Vec<String>,
    /// Everything after the closing `---` line.
    body: String,
    /// The line end of the opening line: the block keeps it.
    line_end: &'static str,
}

fn without_return(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// Cuts a note at its properties block. `None` when the note has none.
fn split(text: &str) -> Option<Parts> {
    let lines: Vec<&str> = text.split('\n').collect();
    let first = lines.first()?;
    if without_return(first) != "---" || lines.len() < 2 {
        return None;
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| without_return(line) == "---")
        .map(|(index, _)| index)?;
    Some(Parts {
        properties: lines[1..close]
            .iter()
            .map(|line| without_return(line).to_owned())
            .collect(),
        body: lines[close + 1..].join("\n"),
        line_end: if first.ends_with('\r') { "\r\n" } else { "\n" },
    })
}

fn join(parts: &Parts) -> String {
    let mut lines = vec!["---"];
    lines.extend(parts.properties.iter().map(String::as_str));
    lines.push("---");
    format!("{}\n{}", lines.join(parts.line_end), parts.body)
}

/// True when the line starts the property: the key at the start of the line,
/// then a colon.
fn starts(line: &str, key: &str) -> bool {
    line.strip_prefix(key)
        .is_some_and(|rest| rest.starts_with(':'))
}

/// True when the line belongs to the property above it: it is indented, or it
/// is a list item.
fn continues(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t') || line.starts_with('-')
}

/// The text after the colon of a property, without the spaces around it.
/// `None` when the note has no such property.
pub fn property_value(text: &str, key: &str) -> Option<String> {
    let parts = split(text)?;
    let line = parts.properties.iter().find(|line| starts(line, key))?;
    Some(line[key.len() + 1..].trim().to_owned())
}

/// The note without the property. The same text when the note has no such
/// property.
pub fn remove_property(text: &str, key: &str) -> String {
    let Some(mut parts) = split(text) else {
        return text.to_owned();
    };
    let Some(start) = parts.properties.iter().position(|line| starts(line, key)) else {
        return text.to_owned();
    };
    let mut end = start + 1;
    while end < parts.properties.len() && continues(&parts.properties[end]) {
        end += 1;
    }
    parts.properties.drain(start..end);
    join(&parts)
}

/// The note with the property set to the value. An existing property keeps its
/// place. A new one is the last line of the properties, where Obsidian adds a
/// property. A note without properties gets a block with this one property.
pub fn set_property(text: &str, key: &str, value: &str) -> String {
    let line = format!("{key}: {value}");
    let Some(parts) = split(text) else {
        return format!("---\n{line}\n---\n{text}");
    };
    let start = parts.properties.iter().position(|line| starts(line, key));
    let Some(mut without) = split(&remove_property(text, key)) else {
        return text.to_owned();
    };
    let at = start.unwrap_or(without.properties.len());
    without.properties.insert(at, line);
    join(&without)
}
