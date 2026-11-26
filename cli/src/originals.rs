//! The original of a note on the main site (ADR 0010, IDX-11 to IDX-13,
//! PUB-100): a note of a type that the main site also publishes names the
//! post there in its canonical link, once the tool checked at publication
//! that the post answers 200 and names itself. The manifest entry keeps the
//! result of the check (`original`); the build reads only that and opens no
//! connection. The rules are in `documentation/Canonical Form.md`, section
//! "The original of a note", with the shared cases of
//! `fixtures/canonical/originals.json`. The TypeScript twin is
//! `apps/plugin/src/publishing/originals.ts`.

use std::collections::BTreeMap;
use std::io::Read;
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::frontmatter::text_property;
use crate::note_types::NoteType;

/// The origin of the main site. A post URL names a page of it.
pub const MAIN_SITE_ORIGIN: &str = "https://www.dsebastien.net";

/// The host of the main site.
const MAIN_SITE_HOST: &str = "www.dsebastien.net";

/// The host of this site: a post that names it as its original makes a loop.
const NOTES_HOST: &str = "notes.dsebastien.net";

/// The note types whose notes also exist on the main site: articles, news
/// posts and newsletters (decision of the author on issue 55). Only the type
/// counts.
pub const ORIGINAL_NOTE_TYPES: [&str; 3] = ["own-articles", "own-news", "own-newsletters"];

/// The property of a note that holds the URL of its post.
pub const POST_URL_PROPERTY: &str = "url";

/// The most notes that the check asks the main site for at one time.
pub const CHECK_CONCURRENCY: usize = 4;

/// The time limit of one check, redirects included, in seconds.
pub const CHECK_TIME_LIMIT: u64 = 10;

/// The most bytes of a page that a check reads.
pub const CHECK_SIZE_LIMIT: usize = 1024 * 1024;

/// The most redirects that a check follows.
pub const CHECK_REDIRECTS: u32 = 5;

/// The user agent of a check. It names the tool and nothing of the person who
/// runs it.
pub const CHECK_USER_AGENT: &str = "dsebastien-vault-publish (check of the original)";

/// The result of a check that passed, as the manifest entry keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Original {
    /// The time of the run of the check.
    pub checked: String,
    /// The post URL, in its comparison form.
    pub url: String,
}

/// The answer of the main site to one request, after its redirects.
#[derive(Clone, Debug)]
pub struct PageAnswer {
    /// The status of the last answer.
    pub status: u64,
    /// The URL of the last answer.
    pub url: String,
    /// The first bytes of the page, as UTF-8 text.
    pub body: String,
}

/// True when notes of this type also exist on the main site (IDX-11).
pub fn has_original(note_type: Option<&NoteType>) -> bool {
    note_type.is_some_and(|note_type| ORIGINAL_NOTE_TYPES.contains(&note_type.name.as_str()))
}

/// The comparison form of a URL (rule 2 of "The original of a note"): the
/// scheme `https`, the host in small letters, no default port, a path that
/// ends in a slash, the query when it is not empty, and no fragment. `None`
/// when the text is not an `http` or `https` URL in the form that the check
/// reads.
pub fn comparison_form(text: &str) -> Option<String> {
    let trimmed = text.trim_matches([' ', '\t', '\n', '\r']);
    let separator = trimmed.find("://")?;
    let scheme = trimmed[..separator].to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let rest = &trimmed[separator + 3..];
    if rest
        .chars()
        .any(|character| character <= ' ' || character == '\u{7f}' || "\\\"<>".contains(character))
    {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let (host, port) = match authority.find(':') {
        Some(colon) => (&authority[..colon], Some(&authority[colon + 1..])),
        None => (authority, None),
    };
    let host = host.to_ascii_lowercase();
    if host.is_empty()
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        || port
            .is_some_and(|port| port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    let tail = &rest[end..];
    let kept = tail.find('#').map_or(tail, |fragment| &tail[..fragment]);
    let (path, query) = kept.find('?').map_or((kept, ""), |question| {
        (&kept[..question], &kept[question..])
    });
    let shown = match port {
        None | Some("443" | "80") => host,
        Some(port) => format!("{host}:{port}"),
    };
    let slashed = if path.is_empty() {
        "/".to_owned()
    } else if path.ends_with('/') {
        path.to_owned()
    } else {
        format!("{path}/")
    };
    let query = if query == "?" { "" } else { query };
    Some(format!("https://{shown}{slashed}{query}"))
}

/// The host of a URL in the comparison form.
fn host_of(form: &str) -> &str {
    let rest = form.strip_prefix("https://").unwrap_or(form);
    rest.find('/').map_or(rest, |end| &rest[..end])
}

/// The post URL of a note (rule 3): its property `url`, in the comparison
/// form, when it names a page of the main site: its host with no other port,
/// a path that is not the root, and no query. `None` in every other case.
pub fn post_url_of(source: &str) -> Option<String> {
    let form = comparison_form(&text_property(source, POST_URL_PROPERTY)?)?;
    if host_of(&form) != MAIN_SITE_HOST {
        return None;
    }
    let path = &form[format!("https://{MAIN_SITE_HOST}").len()..];
    (path != "/" && !path.contains('?')).then_some(form)
}

fn is_space(byte: Option<&u8>) -> bool {
    matches!(byte, Some(b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
}

/// The references of characters that an address of a link can hold, in small
/// letters.
const REFERENCES: [(&str, char); 6] = [
    ("&amp;", '&'),
    ("&quot;", '"'),
    ("&#39;", '\''),
    ("&#x27;", '\''),
    ("&#47;", '/'),
    ("&#x2f;", '/'),
];

/// The value of an attribute with its references of characters read (rule
/// 4).
fn decoded(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut result = String::new();
    let mut at = 0;
    while at < value.len() {
        if bytes[at] == b'&' {
            let found = REFERENCES.iter().find(|(name, _)| {
                bytes
                    .get(at..at + name.len())
                    .is_some_and(|part| part.eq_ignore_ascii_case(name.as_bytes()))
            });
            if let Some((name, character)) = found {
                result.push(*character);
                at += name.len();
                continue;
            }
        }
        let character = value[at..].chars().next().unwrap_or_default();
        result.push(character);
        at += character.len_utf8().max(1);
    }
    result
}

/// The attributes of a tag from a place after its name, up to its `>`: each
/// name one time, the first one counts.
fn attributes_of(html: &str, start: usize) -> BTreeMap<String, String> {
    let bytes = html.as_bytes();
    let mut attributes = BTreeMap::new();
    let mut at = start;
    while at < bytes.len() {
        while is_space(bytes.get(at)) || bytes.get(at) == Some(&b'/') {
            at += 1;
        }
        if at >= bytes.len() || bytes[at] == b'>' {
            break;
        }
        let name_start = at;
        while at < bytes.len()
            && !is_space(bytes.get(at))
            && !matches!(bytes[at], b'/' | b'>' | b'=')
        {
            at += 1;
        }
        // A `=` that starts a name is part of it, as in HTML.
        if at == name_start {
            at += 1;
        }
        let name = html[name_start..at].to_ascii_lowercase();
        let mut after = at;
        while is_space(bytes.get(after)) {
            after += 1;
        }
        let mut value = "";
        if bytes.get(after) == Some(&b'=') {
            at = after + 1;
            while is_space(bytes.get(at)) {
                at += 1;
            }
            match bytes.get(at) {
                Some(&quote) if quote == b'"' || quote == b'\'' => {
                    let end = html[at + 1..]
                        .find(char::from(quote))
                        .map_or(html.len(), |close| at + 1 + close);
                    value = &html[at + 1..end];
                    at = end + 1;
                }
                _ => {
                    let value_start = at;
                    while at < bytes.len() && !is_space(bytes.get(at)) && bytes[at] != b'>' {
                        at += 1;
                    }
                    value = &html[value_start..at];
                }
            }
        }
        attributes.entry(name).or_insert_with(|| decoded(value));
    }
    attributes
}

/// The canonical links of a page (rule 4): the address of each `link`
/// element whose `rel` has the word `canonical`, in the head of the page (up
/// to its first `</head`, or the whole page without one), in the order of the
/// page. An address from the root of the host or without a scheme is read
/// from the URL of the page; any other address stays as it is written.
pub fn canonical_links_of(html: &str, page: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let head = lower.find("</head").unwrap_or(lower.len());
    let page_form = comparison_form(page).unwrap_or_else(|| "https://".to_owned());
    let origin = format!("https://{}", host_of(&page_form));
    let bytes = html.as_bytes();
    let mut links = Vec::new();
    let mut found = lower.find("<link");
    while let Some(at) = found.filter(|at| *at < head) {
        let after = at + "<link".len();
        let next = bytes.get(after);
        if is_space(next) || matches!(next, Some(b'/' | b'>')) {
            let attributes = attributes_of(html, after);
            let rel = attributes.get("rel").map_or("", String::as_str);
            let href = attributes
                .get("href")
                .map_or("", String::as_str)
                .trim_matches([' ', '\t', '\n', '\r', '\x0c']);
            let canonical = rel
                .to_ascii_lowercase()
                .split([' ', '\t', '\n', '\r', '\x0c'])
                .any(|word| word == "canonical");
            if canonical && !href.is_empty() {
                links.push(if href.starts_with("//") {
                    format!("https:{href}")
                } else if href.starts_with('/') {
                    format!("{origin}{href}")
                } else {
                    href.to_owned()
                });
            }
        }
        found = lower[after..].find("<link").map(|next| after + next);
    }
    links
}

/// The judgment of the answer of the main site for a post URL (rule 5): the
/// post is verified when the request ended at the post URL with 200, and
/// every canonical link of the page names the post URL.
///
/// # Errors
///
/// The reason when the post is not verified, for the publication report.
pub fn judge_post(url: &str, answer: Result<&PageAnswer, &str>) -> Result<(), String> {
    let answer = answer.map_err(|failure| format!("the check of {url} failed: {failure}"))?;
    if comparison_form(&answer.url).as_deref() != Some(url) {
        return Err(format!(
            "{url} redirects to {}: write the address of the post into the property url",
            answer.url
        ));
    }
    if answer.status != 200 {
        return Err(format!("{url} answers {}, not 200", answer.status));
    }
    let links = canonical_links_of(&answer.body, url);
    let mut forms: Vec<String> = Vec::new();
    for link in &links {
        let form = comparison_form(link).unwrap_or_else(|| link.clone());
        if !forms.contains(&form) {
            forms.push(form);
        }
    }
    match forms.as_slice() {
        [] => Err(format!("the post {url} has no canonical link")),
        [named] if named == url => Ok(()),
        [named] if named.starts_with("https://") && host_of(named) == NOTES_HOST => Err(format!(
            "the post {url} names {named} as its original: each site would name the other (a loop). The post must name itself"
        )),
        [named] => Err(format!(
            "the post {url} names {named} as its original, not itself"
        )),
        _ => Err(format!(
            "the post {url} has canonical links to more than one URL: {}",
            links.join(", ")
        )),
    }
}

/// How the main site is reached.
enum Reach {
    /// Over the network, with `curl`.
    Network,
    /// Not at all: no post is checked.
    Nowhere,
    /// From a file of answers, in the tests.
    #[cfg(debug_assertions)]
    File(PathBuf),
}

/// The main site, for the check of the original of a note (PUB-100).
pub struct MainSite {
    reach: Reach,
}

/// A note of a publication, for the check.
pub struct CheckedNote<'a> {
    pub path: &'a str,
    pub note_type: Option<&'a NoteType>,
    /// The source of the note.
    pub source: &'a str,
}

/// The result of the check of one note: the original to record, or why there
/// is none.
pub type CheckResult = Result<Original, String>;

impl MainSite {
    /// The main site over the network. In the debug build, the switch
    /// `DSEBASTIEN_VAULT_PUBLISH_TEST_MAIN_SITE` gives `none` (no post is
    /// checked) or a file of answers (the twin of `fileMainSite` of the
    /// TypeScript tests): no test reaches the real main site.
    pub fn network() -> Self {
        #[cfg(debug_assertions)]
        if let Some(switch) = std::env::var_os("DSEBASTIEN_VAULT_PUBLISH_TEST_MAIN_SITE") {
            return Self {
                reach: if switch == "none" {
                    Reach::Nowhere
                } else {
                    Reach::File(PathBuf::from(switch))
                },
            };
        }
        Self {
            reach: Reach::Network,
        }
    }

    /// Asks for the page at the URL, with `GET`: it follows redirects within
    /// `https` only, has a time limit and reads at most a limit of bytes.
    fn page(&self, url: &str) -> Result<PageAnswer, String> {
        match &self.reach {
            Reach::Network => page_of_curl(url),
            Reach::Nowhere => Err("the main site is not asked".to_owned()),
            #[cfg(debug_assertions)]
            Reach::File(file) => page_of_file(file, url),
        }
    }

    /// Checks the post of each note of a type with an original (rule 6),
    /// with at most `CHECK_CONCURRENCY` requests at one time. A note of
    /// another type has no result. The check never fails: a failure is a
    /// reason.
    pub fn check(&self, notes: &[CheckedNote], time: &str) -> BTreeMap<String, CheckResult> {
        let mut results = BTreeMap::new();
        let mut asked: Vec<(String, String)> = Vec::new();
        for note in notes {
            if !has_original(note.note_type) {
                continue;
            }
            match post_url_of(note.source) {
                None => {
                    results.insert(
                        note.path.to_owned(),
                        Err(format!(
                            "the note has no property {POST_URL_PROPERTY} with the address of a post of {MAIN_SITE_ORIGIN}"
                        )),
                    );
                }
                Some(url) if matches!(self.reach, Reach::Nowhere) => {
                    results.insert(
                        note.path.to_owned(),
                        Err(format!(
                            "the post {url} was not checked: this face has no check of the main site"
                        )),
                    );
                }
                Some(url) => asked.push((note.path.to_owned(), url)),
            }
        }
        let next = Mutex::new(asked.into_iter());
        let found = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..CHECK_CONCURRENCY {
                scope.spawn(|| {
                    loop {
                        let item = next.lock().map_or(None, |mut items| items.next());
                        let Some((path, url)) = item else {
                            return;
                        };
                        let answer = self.page(&url);
                        let judged = judge_post(&url, answer.as_ref().map_err(String::as_str));
                        let result = judged.map(|()| Original {
                            checked: time.to_owned(),
                            url,
                        });
                        if let Ok(mut found) = found.lock() {
                            found.push((path, result));
                        }
                    }
                });
            }
        });
        results.extend(found.into_inner().unwrap_or_default());
        results
    }
}

/// The page at the URL through `curl`, which every system of the author has.
fn page_of_curl(url: &str) -> Result<PageAnswer, String> {
    let mut child = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--location",
            "--max-redirs",
            &CHECK_REDIRECTS.to_string(),
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-time",
            &CHECK_TIME_LIMIT.to_string(),
            "--max-filesize",
            &CHECK_SIZE_LIMIT.to_string(),
            "--user-agent",
            CHECK_USER_AGENT,
            "--header",
            "Accept: text/html",
            "--write-out",
            "\n%{http_code} %{url_effective}",
            "--",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl cannot be started ({error})"))?;
    // The page, its last line and some room: a page above the limit is never
    // read to its end, also when the host does not give its size.
    let room = CHECK_SIZE_LIMIT + 4096;
    let mut output = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let _ = stdout.take(room as u64 + 1).read_to_end(&mut output);
    }
    if output.len() > room {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("the page is larger than {CHECK_SIZE_LIMIT} bytes"));
    }
    let mut errors = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut errors);
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        let message = errors.trim();
        return Err(if message.is_empty() {
            format!("curl ended with {status}")
        } else {
            message.to_owned()
        });
    }
    let text = String::from_utf8_lossy(&output);
    let (body, last) = text
        .rsplit_once('\n')
        .ok_or_else(|| "curl gave no status".to_owned())?;
    let (code, effective) = last
        .split_once(' ')
        .ok_or_else(|| "curl gave no status".to_owned())?;
    if body.len() > CHECK_SIZE_LIMIT {
        return Err(format!("the page is larger than {CHECK_SIZE_LIMIT} bytes"));
    }
    Ok(PageAnswer {
        status: code
            .parse()
            .map_err(|_| format!("curl gave the status \"{code}\""))?,
        url: effective.to_owned(),
        body: body.to_owned(),
    })
}

/// The answer of a file of the tests: an object with `answers`, for each URL
/// a page (`status`, `url`, `body`) or `{ "failure": <text> }`. A URL that
/// the file does not name has no answer.
#[cfg(debug_assertions)]
fn page_of_file(file: &std::path::Path, url: &str) -> Result<PageAnswer, String> {
    let text = std::fs::read_to_string(file).map_err(|error| error.to_string())?;
    let data: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let answer = &data["answers"][url];
    if !answer.is_object() {
        return Err("the main site gave no answer".to_owned());
    }
    if let Some(failure) = answer["failure"].as_str() {
        return Err(failure.to_owned());
    }
    page_of_value(answer).ok_or_else(|| format!("the answer for {url} is not a page"))
}

/// A page as data: `status`, `url` and `body`.
#[cfg(any(debug_assertions, test))]
fn page_of_value(value: &Value) -> Option<PageAnswer> {
    Some(PageAnswer {
        status: value["status"].as_u64()?,
        url: value["url"].as_str()?.to_owned(),
        body: value["body"].as_str()?.to_owned(),
    })
}

/// The `original` of a manifest entry: exactly a text `checked` and a text
/// `url`. `None` for every other value.
pub fn original_of_entry(value: &Value) -> Option<Original> {
    let object = value.as_object()?;
    if object.len() != 2 {
        return None;
    }
    Some(Original {
        checked: object.get("checked")?.as_str()?.to_owned(),
        url: object.get("url")?.as_str()?.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ORIGINAL_NOTE_TYPES, PageAnswer, canonical_links_of, comparison_form, judge_post,
        page_of_value, post_url_of,
    };
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/originals.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/originals.json");

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
    fn has_the_note_types_of_the_shared_cases() {
        let all: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let types: Vec<&str> = all["noteTypes"]
            .as_array()
            .expect("the list")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(types, ORIGINAL_NOTE_TYPES);
    }

    #[test]
    fn gives_the_comparison_forms_of_the_shared_cases() {
        for case in &cases("forms") {
            assert_eq!(
                comparison_form(text(case, "text")).as_deref(),
                case["form"].as_str(),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn reads_the_post_urls_of_the_shared_cases() {
        for case in &cases("properties") {
            assert_eq!(
                post_url_of(text(case, "note")).as_deref(),
                case["url"].as_str(),
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn reads_the_canonical_links_of_the_shared_cases() {
        for case in &cases("canonicals") {
            let links: Vec<String> = case["links"]
                .as_array()
                .expect("a case has the list")
                .iter()
                .map(|link| link.as_str().expect("a text").to_owned())
                .collect();
            assert_eq!(
                canonical_links_of(text(case, "html"), text(case, "page")),
                links,
                "{}",
                text(case, "name")
            );
        }
    }

    #[test]
    fn judges_the_posts_of_the_shared_cases() {
        for case in &cases("judged") {
            let url = text(case, "url");
            let answer = &case["answer"];
            let page: Option<PageAnswer> = page_of_value(answer);
            let judged = match (&page, answer["failure"].as_str()) {
                (_, Some(failure)) => judge_post(url, Err(failure)),
                (Some(page), None) => judge_post(url, Ok(page)),
                (None, None) => panic!("{}: an answer is a page or a failure", text(case, "name")),
            };
            assert_eq!(
                Some(judged.is_ok()),
                case["verified"].as_bool(),
                "{}",
                text(case, "name")
            );
            if let Err(reason) = judged {
                assert!(reason.contains(url), "{}", text(case, "name"));
            }
        }
    }
}
