//! The properties of a note, read and written as text.
//!
//! The publishing logic exists two times, and two YAML libraries never agree
//! on every byte. So both implementations work on lines, with the rules of
//! `documentation/Canonical Form.md` (section "Notes and their properties").
//! The TypeScript twin is `apps/plugin/src/publishing/frontmatter.ts`. Change
//! both in the same commit.

use crate::names::{first_part, is_reserved_root_name};
use crate::order::sort_by_code_point;

/// The byte order mark. The marks at the start of a note are not part of its
/// first line.
pub const MARK: char = '\u{feff}';

/// The text without the byte order marks at its start: none, one, or more.
pub fn without_marks(text: &str) -> &str {
    text.trim_start_matches(MARK)
}

/// One line of a note: its text, and its line end (`\n`, `\r\n`, or nothing
/// for a last line without one).
struct Line {
    text: String,
    end: &'static str,
}

/// A note cut in lines.
struct Note {
    /// The number of byte order marks at the start of the note.
    marks: usize,
    lines: Vec<Line>,
    /// The index of the line that closes the properties. `None` when the note
    /// has no closed properties.
    close: Option<usize>,
    /// True when the first line opens properties, closed or not.
    opened: bool,
}

fn is_blank(byte: u8) -> bool {
    byte == b' ' || byte == b'\t'
}

/// The text without the spaces and the tabs around it. No other character is
/// removed.
fn trim(text: &str) -> &str {
    text.trim_matches([' ', '\t'])
}

/// True when the line opens or closes the properties: `---`, then spaces and
/// tabs only.
///
/// `loose` accepts carriage returns after the hyphens too. Only the guard
/// reads in that way, as a second reading, so that it fails closed on a line
/// `---` with two carriage returns before its line feed.
fn is_fence(line: &str, loose: bool) -> bool {
    line.strip_prefix("---").is_some_and(|rest| {
        if loose {
            rest.trim_matches([' ', '\t', '\r']).is_empty()
        } else {
            trim(rest).is_empty()
        }
    })
}

fn read(text: &str) -> Note {
    read_with(text, false)
}

fn read_with(text: &str, loose: bool) -> Note {
    let rest = without_marks(text);
    let marks = (text.len() - rest.len()) / MARK.len_utf8();
    let pieces: Vec<&str> = rest.split('\n').collect();
    let mut lines = Vec::new();
    for (index, piece) in pieces.iter().enumerate() {
        if index < pieces.len() - 1 {
            lines.push(match piece.strip_suffix('\r') {
                Some(text) => Line {
                    text: text.to_owned(),
                    end: "\r\n",
                },
                None => Line {
                    text: (*piece).to_owned(),
                    end: "\n",
                },
            });
        } else if !piece.is_empty() {
            lines.push(Line {
                text: (*piece).to_owned(),
                end: "",
            });
        }
    }
    let opened = lines
        .first()
        .is_some_and(|line| is_fence(&line.text, loose));
    let close = if opened {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| is_fence(&line.text, loose))
            .map(|(index, _)| index)
    } else {
        None
    };
    Note {
        marks,
        lines,
        close,
        opened,
    }
}

fn write(note: &Note) -> String {
    let mut text = String::new();
    for _ in 0..note.marks {
        text.push(MARK);
    }
    for line in &note.lines {
        text.push_str(&line.text);
        text.push_str(line.end);
    }
    text
}

/// The value of the line when the line names the key: an optional quote, the
/// key, an optional quote, optional spaces and tabs, a colon. `None` when it
/// does not.
///
/// `indented` accepts spaces and tabs before the key. `any_case` compares the
/// key without regard to the case of ASCII letters.
fn value_of<'a>(line: &'a str, key: &str, indented: bool, any_case: bool) -> Option<&'a str> {
    let bytes = line.as_bytes();
    let is_quote = |at: usize| {
        bytes
            .get(at)
            .is_some_and(|byte| *byte == b'"' || *byte == b'\'')
    };
    let skip_blanks = |mut at: usize| {
        while bytes.get(at).is_some_and(|byte| is_blank(*byte)) {
            at += 1;
        }
        at
    };

    let mut at = if indented { skip_blanks(0) } else { 0 };
    if is_quote(at) {
        at += 1;
    }
    let found = line.get(at..at + key.len())?;
    let same = if any_case {
        found.eq_ignore_ascii_case(key)
    } else {
        found == key
    };
    if !same {
        return None;
    }
    at += key.len();
    if is_quote(at) {
        at += 1;
    }
    at = skip_blanks(at);
    if bytes.get(at) == Some(&b':') {
        Some(trim(&line[at + 1..]))
    } else {
        None
    }
}

/// True when the line belongs to the property above it: it is indented, or it
/// is a list item.
fn continues(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t') || line.starts_with('-')
}

/// The lines of the properties: up to the closing line, or every line when
/// the properties are never closed.
fn property_lines(note: &Note) -> &[Line] {
    if note.opened {
        &note.lines[1..note.close.unwrap_or(note.lines.len())]
    } else {
        &[]
    }
}

/// True when a line of the properties holds the key, unless that line names
/// the key with the value exactly `false`. It is the reading of a guard, so it
/// fails closed: the key counts anywhere in a line (in one line of JSON, in a
/// complex key, inside another word), in any case of its ASCII letters, in
/// quotes, below another key, and with any value. When the properties are
/// never closed, every line of the note is read. The properties are read two
/// times: with the fence lines of the other readers, and with fence lines
/// that also end in carriage returns. The key in either reading excludes the
/// note.
pub fn names_in_properties(text: &str, key: &str) -> bool {
    let wanted = key.to_ascii_lowercase();
    [read_with(text, false), read_with(text, true)]
        .iter()
        .any(|note| {
            property_lines(note).iter().any(|line| {
                line.text.to_ascii_lowercase().contains(&wanted)
                    && value_of(&line.text, key, true, true) != Some("false")
            })
        })
}

/// True when closed properties are in the flow form of YAML: a line of them
/// starts with `{` or `[`, after optional spaces and tabs. A line that the
/// tool adds below such a line is not valid YAML, so the tool never writes
/// into such properties.
pub fn has_flow_properties(text: &str) -> bool {
    let note = read(text);
    note.close.is_some()
        && property_lines(&note).iter().any(|line| {
            let start = trim(&line.text);
            start.starts_with('{') || start.starts_with('[')
        })
}

/// Removes every property of the note itself that names the key, with its
/// lines. It gives the place of the first one, or `None` when there was none.
fn remove(note: &mut Note, key: &str) -> Option<usize> {
    let mut close = note.close?;
    let mut first = None;
    let mut index = 1;
    while index < close {
        if value_of(&note.lines[index].text, key, false, false).is_none() {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        while end < close && continues(&note.lines[end].text) {
            end += 1;
        }
        note.lines.drain(index..end);
        close -= end - index;
        first.get_or_insert(index);
    }
    note.close = Some(close);
    first
}

/// True when the lines from a place on would be read as closed properties: a
/// `---` line, and a later one. The byte order marks at the start of the first
/// line do not count: at the start of a note, they are not part of its first
/// line.
fn has_closed_properties(lines: &[Line], start: usize) -> bool {
    lines
        .get(start)
        .is_some_and(|line| is_fence(without_marks(&line.text), false))
        && lines
            .iter()
            .skip(start + 1)
            .any(|line| is_fence(&line.text, false))
}

/// Removes the two lines of the properties when no line is between them. They
/// stay when the text below them would then be read as properties: a text of
/// the author must never become properties.
fn drop_empty_properties(note: &mut Note) -> bool {
    if note.close != Some(1) || has_closed_properties(&note.lines, 2) {
        return false;
    }
    note.lines.drain(0..2);
    note.close = None;
    note.opened = false;
    true
}

/// The note without the property. When the properties then hold no line, their
/// two lines go too, as when the last property is removed in Obsidian. The
/// same text when the note does not name the property.
pub fn remove_property(text: &str, key: &str) -> String {
    let mut note = read(text);
    if remove(&mut note, key).is_none() {
        return text.to_owned();
    }
    drop_empty_properties(&mut note);
    write(&note)
}

/// The note without the property, and without properties that hold no line,
/// also when the note did not name the property. It is the rule of the source
/// of a note: the result is the same before and after the property is set.
pub fn without_property(text: &str, key: &str) -> String {
    let mut note = read(text);
    let removed = remove(&mut note, key).is_some();
    if drop_empty_properties(&mut note) || removed {
        write(&note)
    } else {
        text.to_owned()
    }
}

/// The note with the property set to the value. An existing property keeps its
/// place. A new one is the last line of the properties, where Obsidian adds a
/// property. A note without closed properties gets a block with this one
/// property, after its byte order mark.
///
/// The result is the same text when the note is already right.
pub fn set_property(text: &str, key: &str, value: &str) -> String {
    let mut note = read(text);
    let end = if note.lines.first().is_some_and(|line| line.end == "\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let line = Line {
        text: format!("{key}: {value}"),
        end,
    };
    let Some(close) = note.close else {
        let fence = || Line {
            text: "---".to_owned(),
            end,
        };
        note.lines.splice(0..0, [fence(), line, fence()]);
        return write(&note);
    };
    let at = remove(&mut note, key).unwrap_or(close);
    note.lines.insert(at, line);
    write(&note)
}

/// The property of the aliases of a note.
const ALIASES: &str = "aliases";

/// The aliases of a note: the ones that get a URL, and the reserved ones,
/// which get none.
#[derive(Debug, Default)]
pub struct Aliases {
    /// Each alias that gets a URL, one time, in the order of the code points.
    pub aliases: Vec<String>,
    /// Each reserved alias, one time, in the order of the code points.
    pub reserved: Vec<String>,
}

/// The text of a list item of a property: after the hyphen. `None` when the
/// line is no list item.
fn list_item_of(line: &str) -> Option<&str> {
    let start = line.trim_start_matches([' ', '\t']);
    let rest = start.strip_prefix('-')?;
    if rest.is_empty() || rest.starts_with([' ', '\t']) {
        Some(rest)
    } else {
        None
    }
}

/// The text between double quotes, with `\"` and `\\` read. `None` for
/// another escape.
fn unescape_double(text: &str) -> Option<String> {
    let mut result = String::with_capacity(text.len());
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            result.push(character);
            continue;
        }
        match characters.next() {
            Some(next @ ('"' | '\\')) => result.push(next),
            _ => return None,
        }
    }
    Some(result)
}

/// One alias from one item of the property. `None` when the item gives no
/// alias.
fn alias_of_item(item: &str) -> Option<String> {
    let text = trim(item);
    let quoted = |quote: char| text.len() >= 2 && text.starts_with(quote) && text.ends_with(quote);
    let alias = if quoted('"') {
        unescape_double(&text[1..text.len() - 1])?
    } else if quoted('\'') {
        text[1..text.len() - 1].replace("''", "'")
    } else {
        let bytes = text.as_bytes();
        let comment = (1..bytes.len()).find(|at| bytes[*at] == b'#' && is_blank(bytes[at - 1]));
        trim(comment.map_or(text, |at| &text[..at - 1])).to_owned()
    };
    if alias.is_empty() { None } else { Some(alias) }
}

/// The end of an item in quotes that starts at a place: the place after its
/// closing quote, or the end of the text.
fn end_of_quoted(bytes: &[u8], start: usize) -> usize {
    let quote = bytes[start];
    let mut at = start + 1;
    while at < bytes.len() {
        if quote == b'"' && bytes[at] == b'\\' {
            at += 2;
            continue;
        }
        if bytes[at] == quote {
            if quote == b'\'' && bytes.get(at + 1) == Some(&b'\'') {
                at += 2;
                continue;
            }
            return at + 1;
        }
        at += 1;
    }
    bytes.len()
}

/// The items of a list in the flow form, without its brackets: cut at each
/// comma that is not inside an item in quotes.
fn flow_items_of(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut items = Vec::new();
    let mut start = 0;
    loop {
        let mut at = start;
        while bytes.get(at).is_some_and(|byte| is_blank(*byte)) {
            at += 1;
        }
        if bytes
            .get(at)
            .is_some_and(|byte| *byte == b'"' || *byte == b'\'')
        {
            at = end_of_quoted(bytes, at);
        }
        match bytes[at.min(bytes.len())..]
            .iter()
            .position(|byte| *byte == b',')
        {
            None => {
                items.push(&text[start..]);
                return items;
            }
            Some(offset) => {
                items.push(&text[start..at + offset]);
                start = at + offset + 1;
            }
        }
    }
}

/// The aliases of a note, from its source (`documentation/Canonical Form.md`,
/// section "The aliases of a note"). Only the property `aliases` of the note
/// itself in closed properties is read. A reserved alias gets no URL: the file
/// of the site wins.
pub fn aliases_of(source: &str) -> Aliases {
    let note = read(source);
    let Some(close) = note.close else {
        return Aliases::default();
    };
    let lines: Vec<&str> = note.lines[1..close]
        .iter()
        .map(|line| line.text.as_str())
        .collect();
    let mut items: Vec<&str> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(value) = value_of(line, ALIASES, false, false) else {
            continue;
        };
        // A value that starts with `#` is a comment: the items follow.
        if value.is_empty() || value.starts_with('#') {
            items.extend(
                lines[index + 1..]
                    .iter()
                    .take_while(|next| continues(next))
                    .filter_map(|next| list_item_of(next)),
            );
        } else if value.len() >= 2 && value.starts_with('[') && value.ends_with(']') {
            items.extend(flow_items_of(&value[1..value.len() - 1]));
        } else {
            items.push(value);
        }
    }
    let mut all: Vec<String> = items.into_iter().filter_map(alias_of_item).collect();
    sort_by_code_point(&mut all);
    all.dedup();
    let (reserved, aliases) = all
        .into_iter()
        .partition(|alias| is_reserved_root_name(first_part(alias)));
    Aliases { aliases, reserved }
}

#[cfg(test)]
mod tests {
    use super::{
        aliases_of, has_flow_properties, names_in_properties, remove_property, set_property,
    };
    use crate::clean::{STATE_PROPERTY, source_of};
    use crate::guards::IGNORE_PROPERTY;
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/frontmatter.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/properties.json");

    fn cases(kind: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        all[kind]
            .as_array()
            .expect("the cases file has the list")
            .clone()
    }

    fn text<'a>(case: &'a Value, key: &str) -> &'a str {
        case[key].as_str().expect("a case has the text")
    }

    #[test]
    fn reads_the_ignore_property_as_the_file_states() {
        let cases = cases("ignored");
        assert!(cases.len() > 20);
        for case in &cases {
            assert_eq!(
                Some(names_in_properties(text(case, "note"), IGNORE_PROPERTY)),
                case["excluded"].as_bool(),
                "{}",
                text(case, "name")
            );
        }
    }

    fn texts(case: &Value, key: &str) -> Vec<String> {
        case[key]
            .as_array()
            .expect("a case has the list")
            .iter()
            .map(|item| item.as_str().expect("an item is a text").to_owned())
            .collect()
    }

    /// The aliases of a note, from its source (section "The aliases of a note").
    #[test]
    fn reads_the_aliases_as_the_file_states() {
        let cases = cases("aliases");
        assert!(cases.len() > 20);
        for case in &cases {
            let aliases = aliases_of(&source_of(text(case, "note")));
            assert_eq!(
                aliases.aliases,
                texts(case, "aliases"),
                "{}",
                text(case, "name")
            );
            assert_eq!(
                aliases.reserved,
                texts(case, "reserved"),
                "{}",
                text(case, "name")
            );
        }
    }

    /// The tool never writes the state property into properties in the flow
    /// form of YAML (`{ }`, `[ ]`): a new line below such a line is not valid
    /// YAML.
    #[test]
    fn finds_the_flow_form_of_the_properties_as_the_file_states() {
        let cases = cases("flow");
        assert!(cases.len() > 10);
        for case in &cases {
            assert_eq!(
                Some(has_flow_properties(text(case, "note"))),
                case["flow"].as_bool(),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn gives_the_source_of_a_note_as_the_file_states() {
        let cases = cases("source");
        assert!(cases.len() > 10);
        for case in &cases {
            assert_eq!(
                source_of(text(case, "note")),
                text(case, "source"),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn sets_the_state_property_as_the_file_states() {
        let cases = cases("state");
        assert!(cases.len() > 10);
        for case in &cases {
            assert_eq!(
                set_property(text(case, "note"), STATE_PROPERTY, "true"),
                text(case, "result"),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn removes_the_state_property_as_the_file_states() {
        let cases = cases("removed");
        assert!(cases.len() > 10);
        for case in &cases {
            assert_eq!(
                remove_property(text(case, "note"), STATE_PROPERTY),
                text(case, "result"),
                "{}",
                text(case, "name")
            );
        }
    }

    /// A correction of the property must never make a note "changed" (PUB-14).
    #[test]
    fn the_source_is_the_same_after_the_property_is_set() {
        for case in &cases("source") {
            assert_eq!(
                source_of(&set_property(text(case, "note"), STATE_PROPERTY, "true")),
                text(case, "source"),
                "{}",
                text(case, "name")
            );
        }
    }
}
