//! The configuration of the publishing tool. It lives in one file of the
//! content store (GATE-04 of the spec). The TypeScript twin is
//! `apps/plugin/src/publishing/configuration.ts`.

use serde_json::Value;

use crate::json::parse_json;

/// The path of the configuration in the content store.
pub const CONFIGURATION_FILE: &str = "configuration.json";

#[derive(Clone, Debug, Default)]
pub struct Configuration {
    /// The vault folders whose notes can never be published.
    pub deny_list: Vec<String>,
}

/// True when the text is a path inside a vault: relative, with `/`, and with
/// no part that leaves a folder.
pub fn is_vault_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Reads the configuration from the text of its file. A content store without
/// the file has an empty deny list. The list `noindexFolders` is optional.
///
/// The text is read as a JSON value and checked by hand, as the TypeScript
/// twin does, so that both accept and refuse the same texts.
///
/// # Errors
///
/// The text is not a valid configuration: a wrong deny list must never be
/// read as an empty one.
pub fn parse_configuration(text: Option<&str>) -> Result<Configuration, String> {
    let Some(text) = text else {
        return Ok(Configuration::default());
    };
    let value = parse_json(text).map_err(|_| format!("{CONFIGURATION_FILE} is not JSON"))?;
    let object = value.as_object();
    let deny_list = folders_of(
        object.and_then(|object| object.get("denyList")),
        "deny list",
    )?;
    // An optional list (R103), but a wrong one is never read as an empty one.
    // The site build applies it; the program only checks it.
    if let Some(noindex_folders) = object.and_then(|object| object.get("noindexFolders")) {
        folders_of(Some(noindex_folders), "noindex folders")?;
    }
    Ok(Configuration { deny_list })
}

/// The folders of a list of the configuration, or an error that names the list.
fn folders_of(list: Option<&Value>, name: &str) -> Result<Vec<String>, String> {
    let not_a_list = || format!("{CONFIGURATION_FILE}: the {name} must be a list of folders");
    let entries = list.and_then(Value::as_array).ok_or_else(not_a_list)?;
    let mut folders = Vec::new();
    for entry in entries {
        folders.push(entry.as_str().ok_or_else(not_a_list)?.to_owned());
    }
    // An entry in another form would match no note: the guard would be open,
    // or the notes of a noindex folder would stay in the index.
    if let Some(wrong) = folders.iter().find(|folder| !is_vault_path(folder)) {
        return Err(format!(
            "{CONFIGURATION_FILE}: the {name} entry \"{wrong}\" is not a vault path. Write a folder as \"Folder/Sub folder\""
        ));
    }
    Ok(folders)
}

#[cfg(test)]
mod tests {
    use super::parse_configuration;
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/configuration.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/configuration.json");

    #[test]
    fn reads_and_refuses_the_texts_of_the_shared_cases() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let cases = cases["cases"]
            .as_array()
            .expect("the cases file has the list");
        assert!(cases.len() > 10);
        for case in cases {
            let read = parse_configuration(case["text"].as_str());
            if let Some(error) = case["error"].as_str() {
                assert_eq!(read.err().as_deref(), Some(error), "{}", case["name"]);
                continue;
            }
            let configuration = read.unwrap_or_else(|error| panic!("{error}"));
            let expected: Vec<String> = case["denyList"]
                .as_array()
                .expect("a valid case has its deny list")
                .iter()
                .map(|folder| folder.as_str().expect("a folder").to_owned())
                .collect();
            assert_eq!(configuration.deny_list, expected, "{}", case["name"]);
        }
    }
}
