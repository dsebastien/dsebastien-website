//! The configuration of the publishing tool. It lives in one file of the
//! content store (GATE-04 of the spec). The TypeScript twin is
//! `apps/plugin/src/publishing/configuration.ts`.

use serde::Deserialize;

/// The path of the configuration in the content store.
pub const CONFIGURATION_FILE: &str = "configuration.json";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    /// The vault folders whose notes can never be published.
    pub deny_list: Vec<String>,
}

/// Reads the configuration from the text of its file. A content store without
/// the file has an empty deny list.
///
/// # Errors
///
/// The text is not a valid configuration: a wrong deny list must never be
/// read as an empty one.
pub fn parse_configuration(text: Option<&str>) -> Result<Configuration, String> {
    let Some(text) = text else {
        return Ok(Configuration::default());
    };
    serde_json::from_str(text)
        .map_err(|_| format!("{CONFIGURATION_FILE}: the deny list must be a list of folders"))
}
