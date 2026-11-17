//! The order of texts in the canonical form
//! (`documentation/Canonical Form.md`). The TypeScript twin is
//! `apps/plugin/src/publishing/order.ts`. Change both in the same commit.

/// Puts texts in the order of the canonical form: by their code points.
///
/// The order of `String` compares the bytes of UTF-8, which is the order of
/// the code points. A vault path is compared as one text, the slash included.
/// Never sort vault paths as `Path` or `PathBuf`: that order compares part by
/// part, so `a/z.md` would come before `a b/c.md`.
pub fn sort_by_code_point(texts: &mut [String]) {
    texts.sort_unstable();
}

#[cfg(test)]
mod tests {
    use super::sort_by_code_point;
    use serde_json::Value;

    /// The case that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/canonical.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/cases.json");

    fn texts(order: &Value, name: &str) -> Vec<String> {
        order[name]
            .as_array()
            .expect("the cases file has the list")
            .iter()
            .map(|text| text.as_str().expect("a path is a text").to_owned())
            .collect()
    }

    #[test]
    fn sorts_the_shared_paths_as_the_file_states() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let mut paths = texts(&cases["order"], "paths");
        let sorted = texts(&cases["order"], "sorted");
        assert!(sorted.len() > 5);
        assert_ne!(paths, sorted);

        sort_by_code_point(&mut paths);

        assert_eq!(paths, sorted);
    }
}
