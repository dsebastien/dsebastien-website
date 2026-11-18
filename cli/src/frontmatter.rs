//! The properties of a note, read and written as text.
//!
//! The publishing logic exists two times, and two YAML libraries never agree
//! on every byte. So both implementations work on lines, with the rules of
//! `documentation/Canonical Form.md` (section "Notes and their properties").
//! The TypeScript twin is `apps/plugin/src/publishing/frontmatter.ts`. Change
//! both in the same commit.

/// The byte order mark. It is not part of the first line of a note.
pub const MARK: char = '\u{feff}';

/// One line of a note: its text, and its line end (`\n`, `\r\n`, or nothing
/// for a last line without one).
struct Line {
    text: String,
    end: &'static str,
}

/// A note cut in lines.
struct Note {
    /// True when the note starts with a byte order mark.
    marked: bool,
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
fn is_fence(line: &str) -> bool {
    line.strip_prefix("---")
        .is_some_and(|rest| trim(rest).is_empty())
}

fn read(text: &str) -> Note {
    let (marked, rest) = match text.strip_prefix(MARK) {
        Some(rest) => (true, rest),
        None => (false, text),
    };
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
    let opened = lines.first().is_some_and(|line| is_fence(&line.text));
    let close = if opened {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| is_fence(&line.text))
            .map(|(index, _)| index)
    } else {
        None
    };
    Note {
        marked,
        lines,
        close,
        opened,
    }
}

fn write(note: &Note) -> String {
    let mut text = String::new();
    if note.marked {
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
/// never closed, every line of the note is read.
pub fn names_in_properties(text: &str, key: &str) -> bool {
    let wanted = key.to_ascii_lowercase();
    property_lines(&read(text)).iter().any(|line| {
        line.text.to_ascii_lowercase().contains(&wanted)
            && value_of(&line.text, key, true, true) != Some("false")
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
/// `---` line, and a later one.
fn has_closed_properties(lines: &[Line], start: usize) -> bool {
    lines.get(start).is_some_and(|line| is_fence(&line.text))
        && lines
            .iter()
            .skip(start + 1)
            .any(|line| is_fence(&line.text))
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

#[cfg(test)]
mod tests {
    use super::{has_flow_properties, names_in_properties, remove_property, set_property};
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
