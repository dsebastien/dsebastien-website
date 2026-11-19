//! The size of an image, from the first bytes of its file (`documentation/
//! Canonical Form.md`, section "The attachments of a note", rule 5). The page
//! sets the width and the height of an image from the manifest, so the build
//! reads no image (PERF-25). The TypeScript twin is
//! `apps/plugin/src/publishing/images.ts`. Change both in the same commit.

/// The width and the height of an image, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageSize {
    pub width: u64,
    pub height: u64,
}

/// A number of `count` bytes at `at`, the high byte first (BE) or the low
/// byte first (LE). `None` when a byte is outside the file.
fn number(bytes: &[u8], at: usize, count: usize, little_endian: bool) -> Option<u64> {
    let part = bytes.get(at..at.checked_add(count)?)?;
    let fold = |value: u64, byte: &u8| value * 256 + u64::from(*byte);
    Some(if little_endian {
        part.iter().rev().fold(0, fold)
    } else {
        part.iter().fold(0, fold)
    })
}

/// True when the bytes at this place are these bytes.
fn is(bytes: &[u8], at: usize, wanted: &[u8]) -> bool {
    at.checked_add(wanted.len())
        .and_then(|end| bytes.get(at..end))
        .is_some_and(|part| part == wanted)
}

/// A size whose two numbers are whole numbers above 0, else no size.
fn sized(width: Option<u64>, height: Option<u64>) -> Option<ImageSize> {
    match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Some(ImageSize { width, height }),
        _ => None,
    }
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

fn webp_size(bytes: &[u8]) -> Option<ImageSize> {
    if is(bytes, 12, b"VP8 ") {
        if !is(bytes, 23, b"\x9d\x01\x2a") {
            return None;
        }
        let width = number(bytes, 26, 2, true)?;
        let height = number(bytes, 28, 2, true)?;
        return sized(Some(width & 0x3fff), Some(height & 0x3fff));
    }
    if is(bytes, 12, b"VP8L") {
        if bytes.get(20) != Some(&0x2f) {
            return None;
        }
        let bits = number(bytes, 21, 4, true)?;
        return sized(Some((bits & 0x3fff) + 1), Some(((bits >> 14) & 0x3fff) + 1));
    }
    if is(bytes, 12, b"VP8X") {
        let width = number(bytes, 24, 3, true)?;
        let height = number(bytes, 27, 3, true)?;
        return sized(Some(width + 1), Some(height + 1));
    }
    None
}

/// True when the Exif segment of a JPEG says that the image is turned by a
/// quarter: a TIFF block with the tag of the rotation, of type 3 and count 1,
/// with a value from 5 to 8. A block that is cut, or that has another form,
/// says nothing. The data of the segment starts at `start` and ends before
/// `end`, after the 6 bytes `Exif`, 0, 0.
fn quarter_turn(bytes: &[u8], start: usize, end: usize) -> bool {
    let tiff = start + 6;
    let little = if is(bytes, tiff, b"II") {
        true
    } else if is(bytes, tiff, b"MM") {
        false
    } else {
        return false;
    };
    // Every read stays inside the segment: a block that is cut says nothing.
    let read = |at: usize, count: usize| -> Option<u64> {
        if at.checked_add(count)? <= end {
            number(bytes, at, count, little)
        } else {
            None
        }
    };
    let turned = || -> Option<bool> {
        if read(tiff + 2, 2)? != 42 {
            return Some(false);
        }
        let list = tiff.checked_add(usize::try_from(read(tiff + 4, 4)?).ok()?)?;
        let count = read(list, 2)?;
        for index in 0..count {
            let tag = list
                .checked_add(2)?
                .checked_add(usize::try_from(index).ok()? * 12)?;
            if read(tag, 2) == Some(0x0112) {
                let value = if read(tag + 2, 2) == Some(3) && read(tag + 4, 4) == Some(1) {
                    read(tag + 8, 2)
                } else {
                    None
                };
                return Some(value.is_some_and(|value| (5..=8).contains(&value)));
            }
        }
        Some(false)
    };
    turned().unwrap_or(false)
}

fn jpeg_size(bytes: &[u8]) -> Option<ImageSize> {
    let mut at = 2;
    let mut turned: Option<bool> = None;
    loop {
        if bytes.get(at) != Some(&0xff) {
            return None;
        }
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        at += 1;
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = usize::try_from(number(bytes, at, 2, false)?).ok()?;
        if length < 2 {
            return None;
        }
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            let height = number(bytes, at + 3, 2, false);
            let width = number(bytes, at + 5, 2, false);
            return if turned == Some(true) {
                sized(height, width)
            } else {
                sized(width, height)
            };
        }
        // Only the first Exif segment counts.
        if marker == 0xe1 && turned.is_none() && is(bytes, at + 2, b"Exif\0\0") {
            turned = Some(quarter_turn(bytes, at + 2, at + length));
        }
        at += length;
    }
}

/// The width and the height of an image, from the first bytes of its file,
/// whatever its name says: PNG, GIF, WebP and JPEG (with the rotation flag of
/// a photo). `None` for every other file, and for a file that is cut.
pub fn image_size(bytes: &[u8]) -> Option<ImageSize> {
    if is(bytes, 0, PNG) {
        return if is(bytes, 12, b"IHDR") {
            sized(number(bytes, 16, 4, false), number(bytes, 20, 4, false))
        } else {
            None
        };
    }
    if is(bytes, 0, b"GIF87a") || is(bytes, 0, b"GIF89a") {
        return sized(number(bytes, 6, 2, true), number(bytes, 8, 2, true));
    }
    if is(bytes, 0, b"RIFF") && is(bytes, 8, b"WEBP") {
        return webp_size(bytes);
    }
    if is(bytes, 0, b"\xff\xd8") {
        return jpeg_size(bytes);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{ImageSize, image_size};
    use serde_json::Value;

    /// The cases that the TypeScript implementation reads too
    /// (`apps/plugin/src/publishing/images.spec.ts`).
    const CASES: &str = include_str!("../../fixtures/canonical/images.json");

    fn bytes_of(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|at| {
                u8::from_str_radix(&hex[at..at + 2], 16).expect("a case has hexadecimal bytes")
            })
            .collect()
    }

    #[test]
    fn gives_the_size_of_each_shared_file_as_the_file_states() {
        let cases: Value = serde_json::from_str(CASES).expect("the cases file is JSON");
        let cases = cases["cases"].as_array().expect("the file has cases");
        assert!(cases.iter().filter(|case| case["width"].is_u64()).count() > 15);
        assert!(cases.iter().filter(|case| case["width"].is_null()).count() > 10);
        for case in cases {
            let name = case["name"].as_str().expect("a case has a name");
            let expected = case["width"].as_u64().map(|width| ImageSize {
                width,
                height: case["height"]
                    .as_u64()
                    .expect("a case with a width has a height"),
            });
            let bytes = bytes_of(case["bytes"].as_str().expect("a case has its bytes"));
            assert_eq!(image_size(&bytes), expected, "{name}");
        }
    }

    #[test]
    fn gives_the_size_of_the_image_of_the_fixture_vault() {
        let bytes = include_bytes!("../../fixtures/vault/Attachments/garden-plan.png");
        assert_eq!(
            image_size(bytes),
            Some(ImageSize {
                width: 16,
                height: 12
            })
        );
    }
}
