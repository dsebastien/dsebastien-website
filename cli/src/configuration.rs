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
/// the file has an empty deny list.
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
    let not_a_list = || format!("{CONFIGURATION_FILE}: the deny list must be a list of folders");
    let entries = value
        .as_object()
        .and_then(|object| object.get("denyList"))
        .and_then(Value::as_array)
        .ok_or_else(not_a_list)?;
    let mut deny_list = Vec::new();
    for entry in entries {
        deny_list.push(entry.as_str().ok_or_else(not_a_list)?.to_owned());
    }
    // An entry in another form would match no note, and the guard would be open.
    if let Some(wrong) = deny_list.iter().find(|folder| !is_vault_path(folder)) {
        return Err(format!(
            "{CONFIGURATION_FILE}: the deny list entry \"{wrong}\" is not a vault path. Write a folder as \"Folder/Sub folder\""
        ));
    }
    Ok(Configuration { deny_list })
}
