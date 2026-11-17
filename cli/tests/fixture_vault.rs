//! The Rust tests read the fixture vault of the repository: the same files
//! that the TypeScript tests read (`packages/testing`).

mod support;

use std::fs;
use std::path::Path;

use support::{fixture_configuration, fixture_vault};

fn note_files(folder: &Path, found: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(folder).expect("the folder can be read") {
        let path = entry.expect("the entry can be read").path();
        if path.is_dir() {
            note_files(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "md") {
            found.push(path);
        }
    }
}

#[test]
fn reads_a_note() {
    let note = fixture_vault().join("10 Garden").join("Compost basics.md");

    let text = fs::read_to_string(note).expect("the note can be read");

    assert!(text.contains("# Compost basics"));
}

#[test]
fn reads_a_note_with_a_name_outside_ascii() {
    let note = fixture_vault()
        .join("20 Library")
        .join("20.02 Recipes")
        .join("Crème brûlée à l'érable.md");

    let text = fs::read_to_string(note).expect("the note can be read");

    assert!(text.contains("maple syrup"));
}

#[test]
fn reads_the_configuration_with_its_deny_list() {
    let configuration =
        fs::read_to_string(fixture_configuration()).expect("the configuration can be read");

    assert!(configuration.contains(r#""denyList""#));
    assert!(configuration.contains(r#""90 Locked Shed""#));
    assert!(fixture_vault().join("90 Locked Shed").is_dir());
}

/// The parity rule compares bytes. A checkout on Windows must give the same
/// bytes as a checkout on Linux, so no note may have Windows line ends.
#[test]
fn notes_have_the_same_line_ends_on_every_system() {
    let mut notes = Vec::new();
    note_files(&fixture_vault(), &mut notes);

    assert!(notes.len() > 30);
    for note in notes {
        let bytes = fs::read(&note).expect("the note can be read");
        assert!(
            !bytes.contains(&b'\r'),
            "{} has Windows line ends",
            note.display()
        );
    }
}
