//! The bar widget's state file (Linux): what the Omarchy bar shows of this
//! desktop. The widget (apps/desk/omarchy/bar/BarWidget.qml) runs nothing and
//! polls nothing; it watches `~/.cache/cobra-desktop/state.json` and reads
//! four numbers from it, the same four the tray tooltip shows, with a clock
//! so a minute of silence reads as "not running".
//!
//! Written whole into a temp file beside it and renamed into place, so the
//! widget never reads half a file. Quickshell's FileView watch follows the
//! path across the rename (checked against the shell this was written for;
//! the widget also reloads on a timer, so an older shell that loses the
//! watch still catches up).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarState {
    /// Sessions waiting on you plus approvals the Lead asked for.
    pub needs_you: u32,
    pub working: u32,
    pub alerts: u32,
    /// Milliseconds since the epoch, when these numbers were last computed.
    pub updated_at: u64,
}

/// `~/.cache/cobra-desktop/state.json`, honouring XDG_CACHE_HOME.
pub fn path() -> Option<PathBuf> {
    let cache = std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty());
    let cache = cache.or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))?;
    Some(cache.join("cobra-desktop").join("state.json"))
}

/// Write `state` to `path` atomically: the folder is made, the body goes to
/// `state.json.tmp` in it, and a rename puts it in place.
pub fn write(path: &Path, state: &BarState) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("state file has no folder"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string(state).map_err(std::io::Error::other)?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cobra-bar-state-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_shape_the_widget_reads() {
        let s = BarState { needs_you: 2, working: 3, alerts: 1, updated_at: 1_700_000_000_000 };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["alerts", "needsYou", "updatedAt", "working"]);
        assert_eq!(v["needsYou"], 2);
        assert_eq!(v["working"], 3);
        assert_eq!(v["alerts"], 1);
        assert_eq!(v["updatedAt"], 1_700_000_000_000u64);
    }

    #[test]
    fn written_whole_and_renamed_into_place() {
        let dir = scratch("atomic");
        let file = dir.join("deeper").join("state.json");
        let first = BarState { needs_you: 1, working: 0, alerts: 0, updated_at: 10 };
        write(&file, &first).unwrap();
        let read: BarState = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(read, first);
        // No temp file is left beside it, and a second write replaces the first.
        let second = BarState { needs_you: 0, working: 4, alerts: 2, updated_at: 20 };
        write(&file, &second).unwrap();
        let left: Vec<String> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["state.json"]);
        let read: BarState = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(read, second);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_path_follows_xdg() {
        // Not a test of the environment: only that the file sits under the cache folder by that name.
        if let Some(p) = path() {
            assert!(p.ends_with("cobra-desktop/state.json"));
        }
    }
}
