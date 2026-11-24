//! The frozen lists of a note (`documentation/Canonical Form.md`, section "The
//! frozen lists of a note"): which notes of a plan have a live query that the
//! page drops (REN-14), and which have a list that the Dataview Serializer
//! runs again after each edit (PUB-35, PUB-101). The TypeScript twin is
//! `apps/plugin/src/publishing/frozen.ts`.

/// The info words of the fences that the page drops: live queries (REN-14).
const LIVE_WORDS: [&str; 5] = ["dataview", "dataviewjs", "base", "bases", "query"];

/// The markers of the queries that the serializer runs again after each
/// edit. The markers of the queries that the author froze on purpose (manual,
/// once, once and eject) are not here (K14 of the study).
const REFRESH_MARKERS: [&str; 6] = [
    "<!-- QueryToSerialize:",
    "<!-- dataview-serializer-query:",
    "<!-- IQ: ",
    "<!-- dataview-serializer-iq: ",
    "<!-- DataviewJSToSerialize:",
    "<!-- dataview-serializer-js:",
];

/// What one line of a note is, for the rules of the frozen lists.
struct Line<'a> {
    /// The info word of the fence that the line opens, or `None` when it
    /// opens none.
    opens: Option<String>,
    /// True when the line is inside a fence, or opens or closes one.
    fenced: bool,
    text: &'a str,
}

/// The body of a line: without the spaces, the tabs and the `>` characters
/// at its start (rule 1).
fn body_of(line: &str) -> &str {
    line.trim_start_matches([' ', '\t', '>'])
}

/// The length of the run of `mark` at the start of a text.
fn run_of(text: &str, mark: char) -> usize {
    text.chars()
        .take_while(|character| *character == mark)
        .count()
}

/// The lines of a source, with the fences of rule 2.
fn lines_of(source: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for text in source.split('\n') {
        let body = body_of(text);
        if let Some((mark, opening)) = fence {
            let length = run_of(body, mark);
            // The marks are ASCII: one byte each.
            if length >= opening && body[length..].chars().all(|c| c == ' ' || c == '\t') {
                fence = None;
            }
            lines.push(Line {
                opens: None,
                fenced: true,
                text,
            });
            continue;
        }
        let mark = body.chars().next();
        let length = match mark {
            Some(mark @ ('`' | '~')) => run_of(body, mark),
            _ => 0,
        };
        if let (Some(mark), true) = (mark, length >= 3) {
            fence = Some((mark, length));
            let rest = body[length..].trim_start_matches([' ', '\t']);
            let word = rest.split([' ', '\t']).next().unwrap_or("");
            lines.push(Line {
                opens: Some(word.to_ascii_lowercase()),
                fenced: true,
                text,
            });
            continue;
        }
        lines.push(Line {
            opens: None,
            fenced: false,
            text,
        });
    }
    lines
}

/// True when the source opens a fence of a live query (rule 3): the page
/// drops it.
pub fn has_live_query(source: &str) -> bool {
    lines_of(source).iter().any(|line| {
        line.opens
            .as_deref()
            .is_some_and(|word| LIVE_WORDS.contains(&word))
    })
}

/// True when a line outside the fences holds a marker of a query that the
/// serializer runs again (rule 4).
pub fn has_list_to_refresh(source: &str) -> bool {
    lines_of(source).iter().any(|line| {
        !line.fenced
            && REFRESH_MARKERS
                .iter()
                .any(|marker| line.text.contains(marker))
    })
}

#[cfg(test)]
mod tests {
    use super::{has_list_to_refresh, has_live_query};
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/frozen.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/frozen.json");

    fn cases() -> Vec<Value> {
        let all: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        all["cases"]
            .as_array()
            .expect("the cases file has the list")
            .clone()
    }

    #[test]
    fn reads_the_frozen_lists_as_the_file_states() {
        let cases = cases();
        assert!(cases.len() > 20);
        for case in &cases {
            let source = case["source"].as_str().expect("a case has a source");
            let name = case["name"].as_str().expect("a case has a name");
            assert_eq!(
                Some(has_live_query(source)),
                case["liveQuery"].as_bool(),
                "{name}: liveQuery"
            );
            assert_eq!(
                Some(has_list_to_refresh(source)),
                case["listToRefresh"].as_bool(),
                "{name}: listToRefresh"
            );
        }
    }
}
