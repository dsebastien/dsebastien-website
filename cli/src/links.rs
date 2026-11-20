//! The links of a note: which note each link leads to (PUB-87, TOOL-07 of the
//! spec). The rules are in `documentation/Canonical Form.md`, section "The
//! links of a note". They follow what Obsidian does, because this program
//! cannot ask Obsidian. The TypeScript twin is
//! `apps/plugin/src/publishing/links.ts`. Change both in the same commit.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::order::sort_by_code_point;
use crate::small_letters::small_letters;

/// One link of a note that leads to a note: the link path as the note writes
/// it, and the vault path of its target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoteLink {
    pub link: String,
    pub path: String,
}

/// The characters that the decoding of a destination leaves as they are
/// written, as `decodeURI` does.
const RESERVED: &str = ";/?:@&=+$,#";

/// The no-break space. Obsidian reads it as a space in a link.
const NO_BREAK_SPACE: char = '\u{a0}';

/// The white space that Obsidian removes at the two ends of a link: what
/// `trim` of JavaScript removes. The list is written out, so that it is the
/// same in TypeScript and with every version of Unicode. `char::is_whitespace`
/// is another list.
fn is_white_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// The text of a link as it is compared: each no-break space as a space,
/// without the white space around it.
fn normal(text: &str) -> String {
    text.replace(NO_BREAK_SPACE, " ")
        .trim_matches(is_white_space)
        .to_owned()
}

/// True for a space (U+0020) and for a tab. No other character is blank here.
fn is_blank(character: char) -> bool {
    character == ' ' || character == '\t'
}

/// The text without the spaces and the tabs around it. No other character is
/// removed.
fn without_blanks(text: &str) -> &str {
    text.trim_matches(is_blank)
}

/// The text up to its first `#`: a link to a heading or to a block has the
/// path of its note.
fn before_hash(text: &str) -> &str {
    text.find('#').map_or(text, |hash| &text[..hash])
}

/// True when the destination starts with a scheme and a colon: it is not a
/// file of the vault. A scheme is an ASCII letter, then ASCII letters, digits,
/// `+`, `-` and `.`.
fn starts_with_scheme(destination: &str) -> bool {
    let mut bytes = destination.bytes();
    if !bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
    {
        return false;
    }
    for byte in bytes {
        match byte {
            b':' => return true,
            b'+' | b'-' | b'.' => {}
            byte if byte.is_ascii_alphanumeric() => {}
            _ => return false,
        }
    }
    false
}

/// The value of a hexadecimal digit, in any letter case.
fn hexadecimal(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        b'A'..=b'F' => Some(digit - b'A' + 10),
        _ => None,
    }
}

/// The byte that a `%` at this place of the text writes, or `None` when two
/// hexadecimal digits do not follow it.
fn byte_at(text: &[u8], index: usize) -> Option<u8> {
    if text.get(index) != Some(&b'%') {
        return None;
    }
    let high = hexadecimal(*text.get(index + 1)?)?;
    let low = hexadecimal(*text.get(index + 2)?)?;
    Some(high * 16 + low)
}

/// The number of bytes of the UTF-8 sequence that this byte starts, or 0 when
/// it starts none.
fn sequence_length(first: u8) -> usize {
    match first {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    }
}

/// The destination of a Markdown link, decoded as a whole. `None` when it
/// cannot be decoded: a `%` without two hexadecimal digits, or bytes that are
/// not UTF-8. A byte order mark is kept as a character.
fn decoded(destination: &str) -> Option<String> {
    let bytes = destination.as_bytes();
    let mut text = String::with_capacity(destination.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            // The text up to the next `%` is kept as it is written.
            let next = destination[index..]
                .find('%')
                .map_or(bytes.len(), |at| index + at);
            text.push_str(&destination[index..next]);
            index = next;
            continue;
        }
        let first = byte_at(bytes, index)?;
        if first < 0x80 {
            let character = char::from(first);
            if RESERVED.contains(character) {
                text.push_str(&destination[index..index + 3]);
            } else {
                text.push(character);
            }
            index += 3;
            continue;
        }
        let length = sequence_length(first);
        if length == 0 {
            return None;
        }
        let mut sequence = vec![first];
        for more in 1..length {
            sequence.push(byte_at(bytes, index + 3 * more)?);
        }
        text.push_str(std::str::from_utf8(&sequence).ok()?);
        index += 3 * length;
    }
    Some(text)
}

/// Adds the link paths of the wikilinks and of the embeds of one line.
fn read_wikilinks(line: &str, found: &mut BTreeSet<String>) {
    let mut rest = line;
    while let Some(close) = rest.find("]]") {
        // The last opening before the first closing.
        let before = &rest[..close];
        if let Some(open) = before.rfind("[[") {
            let inner = &before[open + 2..];
            let target = match inner.find('|') {
                None => inner,
                // In a table, a backslash stands before the bar. It is not
                // part of the target.
                Some(bar) if inner[..bar].ends_with('\\') => &inner[..bar - 1],
                Some(bar) => &inner[..bar],
            };
            found.insert(before_hash(&normal(target)).to_owned());
        }
        rest = &rest[close + 2..];
    }
}

/// Adds the link paths of the Markdown links of one line.
fn read_markdown_links(line: &str, found: &mut BTreeSet<String>) {
    let bytes = line.as_bytes();
    let mut position = 0;
    while let Some(start) = line[position..].find("](") {
        position += start + 2;
        let mut index = position;
        while matches!(bytes.get(index), Some(b' ' | b'\t')) {
            index += 1;
        }
        let destination = if bytes.get(index) == Some(&b'<') {
            let Some(length) = line[index + 1..].find('>') else {
                continue;
            };
            without_blanks(&line[index + 1..index + 1 + length])
        } else {
            // The destination ends before the first space, the first tab, or
            // the first `)` that closes no `(` of the destination.
            let mut depth = 0_usize;
            let mut end = index;
            while let Some(byte) = bytes.get(end) {
                match byte {
                    b' ' | b'\t' => break,
                    b'(' => depth += 1,
                    b')' if depth == 0 => break,
                    b')' => depth -= 1,
                    _ => {}
                }
                end += 1;
            }
            &line[index..end]
        };
        if destination.is_empty() || destination.starts_with('#') || starts_with_scheme(destination)
        {
            continue;
        }
        // A destination that cannot be decoded is read as it is written.
        let path = normal(&decoded(destination).unwrap_or_else(|| destination.to_owned()));
        found.insert(before_hash(&path).to_owned());
    }
}

/// The link paths of a note, from its source: each one time, in the order of
/// the code points. The properties are read like the text. A link path that
/// is empty names the note itself and is left out.
pub fn link_paths_of(source: &str) -> Vec<String> {
    // A set of `String` keeps the order of the code points.
    let mut found = BTreeSet::new();
    // A line ends with a line feed only: the source has no Windows line end.
    for line in source.split('\n') {
        read_wikilinks(line, &mut found);
        read_markdown_links(line, &mut found);
    }
    found.remove("");
    found.into_iter().collect()
}

/// The part of a path after its last slash.
fn name_of(path: &str) -> &str {
    path.rfind('/').map_or(path, |slash| &path[slash + 1..])
}

/// The part of a path before its last slash. The empty text for a path
/// without a slash.
fn folder_of(path: &str) -> &str {
    path.rfind('/').map_or("", |slash| &path[..slash])
}

/// A note of the scan, with its path in small letters.
struct Candidate {
    path: String,
    lower: String,
}

/// The file of the list whose path in small letters is exactly this one.
fn exact<'a>(candidates: &'a [Candidate], wanted: &str) -> Option<&'a str> {
    candidates
        .iter()
        .find(|candidate| candidate.lower == wanted)
        .map(|candidate| candidate.path.as_str())
}

/// The files of a scan, notes and other files, by their names: what a link
/// path is resolved against.
pub struct LinkIndex {
    /// The files by their name in small letters. The files of one name are in
    /// the order of the code points of their paths.
    by_name: BTreeMap<String, Vec<Candidate>>,
}

impl LinkIndex {
    /// The index of the files of a scan, from their vault paths. The order in
    /// which the paths are given changes nothing.
    pub fn new<Files>(files: Files) -> Self
    where
        Files: IntoIterator,
        Files::Item: AsRef<str>,
    {
        let mut paths: Vec<String> = files
            .into_iter()
            .map(|path| path.as_ref().to_owned())
            .collect();
        sort_by_code_point(&mut paths);
        let mut by_name: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
        for path in paths {
            let lower = small_letters(&path);
            by_name
                .entry(name_of(&lower).to_owned())
                .or_default()
                .push(Candidate { path, lower });
        }
        Self { by_name }
    }

    /// The vault path of the file that a link path leads to, from the note
    /// that holds the link: a note or another file. `None` when the link path
    /// has no target.
    pub fn target_of(&self, link_path: &str, from: &str) -> Option<&str> {
        // Step 1: the candidates have the name of the link path. A file that
        // is not a note comes first, as in Obsidian.
        let mut wanted = small_letters(link_path);
        let mut candidates = self.by_name.get(name_of(&wanted));
        if candidates.is_none() {
            // The end is added before the small letters are made.
            wanted = small_letters(&format!("{link_path}.md"));
            candidates = self.by_name.get(name_of(&wanted));
        }
        let candidates = candidates?;
        // Step 2: a name alone that one file has.
        if let ([only], false) = (candidates.as_slice(), wanted.contains('/')) {
            return Some(&only.path);
        }
        // Step 3: a path from the folder of the note.
        let mut folder = small_letters(folder_of(from));
        if wanted.starts_with("./") || wanted.starts_with("../") {
            let mut rest = wanted.as_str();
            if rest.starts_with("./../") {
                rest = &rest[2..];
            }
            if let Some(below) = rest.strip_prefix("./") {
                rest = below;
            } else {
                while let Some(above) = rest.strip_prefix("../") {
                    rest = above;
                    folder = folder_of(&folder).to_owned();
                }
            }
            if !folder.is_empty() {
                folder.push('/');
            }
            wanted = format!("{folder}{rest}");
            if let Some(path) = exact(candidates, &wanted) {
                return Some(path);
            }
        }
        // Step 4: a path from the root.
        if let Some(rest) = wanted.strip_prefix('/') {
            wanted = rest.to_owned();
        }
        if let Some(path) = exact(candidates, &wanted) {
            return Some(path);
        }
        // Step 5.
        if link_path.starts_with('/') {
            return None;
        }
        // Step 6: the end of a path. The notes below the folder come first,
        // then the shorter path.
        let (mut near, mut far): (Vec<&Candidate>, Vec<&Candidate>) = candidates
            .iter()
            .filter(|candidate| candidate.lower.ends_with(&wanted))
            .partition(|candidate| candidate.lower.starts_with(&folder));
        // The sort is stable, and the candidates are in the order of the code
        // points. The length is counted in UTF-16 units, as Obsidian counts.
        let length = |candidate: &&Candidate| candidate.path.encode_utf16().count();
        near.sort_by_cached_key(length);
        far.sort_by_cached_key(length);
        near.first()
            .or(far.first())
            .map(|candidate| candidate.path.as_str())
    }
}

/// The targets of the links of a note, each list sorted by the link path.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Targets {
    /// The list `links` of the manifest entry: the links that lead to a note.
    pub links: Vec<NoteLink>,
    /// The links that lead to a file that is not a note: the attachments of
    /// the note, without their bytes.
    pub files: Vec<NoteLink>,
}

/// True when the name of a path ends in `.md` in any letter case.
fn ends_in_md(path: &str) -> bool {
    path.len() >= 3
        && path.is_char_boundary(path.len() - 3)
        && path[path.len() - 3..].eq_ignore_ascii_case(".md")
}

/// The targets of the links of a note, from its link paths: one item per link
/// path that has a target, sorted by the link path. A target that a guard
/// excludes gives no item, and a file whose name ends in `.md` in another
/// letter case gives none: it is not a note, and as an attachment it would
/// pass the guard of the ignore property.
pub fn resolve_links(
    link_paths: &[String],
    from: &str,
    index: &LinkIndex,
    guarded: &BTreeSet<String>,
) -> Targets {
    let mut targets = Targets::default();
    for link in link_paths {
        let Some(path) = index.target_of(link, from) else {
            continue;
        };
        if guarded.contains(path) {
            continue;
        }
        let item = NoteLink {
            link: link.clone(),
            path: path.to_owned(),
        };
        // A note ends in `.md` in small letters.
        #[allow(clippy::case_sensitive_file_extension_comparisons)]
        if path.ends_with(".md") {
            targets.links.push(item);
        } else if !ends_in_md(path) {
            targets.files.push(item);
        }
    }
    targets
}

/// The targets of the links of a note, from its source.
pub fn links_of(
    source: &str,
    from: &str,
    index: &LinkIndex,
    guarded: &BTreeSet<String>,
) -> Targets {
    resolve_links(&link_paths_of(source), from, index, guarded)
}

/// True when two lists of links say the same: the same items in the same
/// order.
pub fn same_links(one: &[NoteLink], two: &[NoteLink]) -> bool {
    one == two
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{LinkIndex, NoteLink, link_paths_of, links_of, same_links};
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/links.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/links.json");

    fn cases() -> Value {
        serde_json::from_str(CASES).expect("the cases file is JSON")
    }

    fn list<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
        value[key].as_array().expect("the cases file has the list")
    }

    fn text<'a>(case: &'a Value, key: &str) -> &'a str {
        case[key].as_str().expect("a case has the text")
    }

    fn texts(value: &Value, key: &str) -> Vec<String> {
        list(value, key)
            .iter()
            .map(|item| item.as_str().expect("an item is a text").to_owned())
            .collect()
    }

    /// The target that a case states: a vault path, or `None` for `null`.
    fn target(case: &Value) -> Option<&str> {
        let target = &case["target"];
        assert!(
            target.is_string() || target.is_null(),
            "{}: the target is a path or null",
            text(case, "name")
        );
        target.as_str()
    }

    fn link(link: &str, path: &str) -> NoteLink {
        NoteLink {
            link: link.to_owned(),
            path: path.to_owned(),
        }
    }

    #[test]
    fn gives_the_link_paths_of_each_shared_text_as_the_file_states() {
        let cases = cases();
        let cases = list(&cases, "linkPaths");
        assert!(cases.len() > 12);
        for case in cases {
            assert_eq!(
                link_paths_of(text(case, "text")),
                texts(case, "linkPaths"),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn gives_the_target_of_each_shared_link_path_as_the_file_states() {
        let cases = cases();
        let index = LinkIndex::new(texts(&cases["targets"], "files"));
        let cases = list(&cases["targets"], "cases");
        assert!(cases.len() > 25);
        for case in cases {
            assert_eq!(
                index.target_of(text(case, "link"), text(case, "from")),
                target(case),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn the_order_in_which_the_notes_are_given_changes_nothing() {
        let cases = cases();
        let notes = texts(&cases["targets"], "files");
        // The list of the file, turned around, and a list in an order that is
        // neither: the second half before the first one.
        let reversed: Vec<String> = notes.iter().rev().cloned().collect();
        let (first, second) = notes.split_at(notes.len() / 2);
        let halves: Vec<String> = second.iter().chain(first).cloned().collect();
        assert_ne!(reversed, notes);
        assert_ne!(halves, notes);

        for order in [reversed, halves] {
            let index = LinkIndex::new(&order);
            for case in list(&cases["targets"], "cases") {
                assert_eq!(
                    index.target_of(text(case, "link"), text(case, "from")),
                    target(case),
                    "{}",
                    text(case, "name")
                );
            }
        }
    }

    #[test]
    fn every_file_of_the_shared_list_exists_for_a_case_to_find() {
        let cases = cases();
        let notes = texts(&cases["targets"], "files");
        for case in list(&cases["targets"], "cases") {
            let name = text(case, "name");
            assert!(
                notes.iter().any(|note| note == text(case, "from")),
                "{name}"
            );
            if let Some(target) = target(case) {
                assert!(notes.iter().any(|note| note == target), "{name}");
            }
        }
    }

    #[test]
    fn gives_the_links_of_each_shared_note_as_the_file_states() {
        let cases = cases();
        let cases = list(&cases, "links");
        assert!(cases.len() > 2);
        assert!(
            cases
                .iter()
                .any(|case| !list(case, "attachments").is_empty())
        );
        for case in cases {
            let name = text(case, "name");
            let guarded: BTreeSet<String> = texts(case, "guarded").into_iter().collect();
            let items = |key: &str| -> Vec<NoteLink> {
                list(case, key)
                    .iter()
                    .map(|item| {
                        let members = item.as_object().expect("an item is an object");
                        assert_eq!(members.len(), 2, "{name}");
                        link(text(item, "link"), text(item, "path"))
                    })
                    .collect()
            };

            let targets = links_of(
                text(case, "text"),
                text(case, "from"),
                &LinkIndex::new(texts(case, "files")),
                &guarded,
            );

            assert_eq!(targets.links, items("links"), "{name}");
            assert_eq!(targets.files, items("attachments"), "{name}");
        }
    }

    #[test]
    fn two_lists_are_the_same_only_with_the_same_items_in_the_same_order() {
        let one = link("Alpha", "Alpha.md");
        let two = link("Beta", "Folder/Beta.md");
        assert!(same_links(&[], &[]));
        assert!(same_links(
            &[one.clone(), two.clone()],
            &[link("Alpha", "Alpha.md"), link("Beta", "Folder/Beta.md")]
        ));
        assert!(!same_links(
            &[one.clone(), two.clone()],
            &[two.clone(), one.clone()]
        ));
        assert!(!same_links(
            std::slice::from_ref(&one),
            &[one.clone(), two.clone()]
        ));
        assert!(!same_links(
            std::slice::from_ref(&one),
            &[link("Alpha", "Other/Alpha.md")]
        ));
        assert!(!same_links(
            std::slice::from_ref(&one),
            &[link("alpha", "Alpha.md")]
        ));
    }
}
