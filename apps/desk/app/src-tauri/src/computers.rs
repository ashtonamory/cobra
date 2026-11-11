//! Where everything is: the one agent this desktop talks to, and its pins.
//!
//! Cobra is one computer: the agent runs here and answers on loopback. It gave
//! this desktop a key of its own (`cobra-agent desk`); that answer is kept in
//! computers.json, in the app's own config folder, 0600. The key never leaves
//! this side: the web UI gets the agent without its key (`Machine`), and every
//! request is made here (api.rs).

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// The agent's hostname, as its desk line said; /projects reports this, so it is the key every
    /// request and row uses. The name a person reads is `label`.
    pub machine: String,
    pub label: String,
    pub title: String,
    /// Where its agent answers: always http://127.0.0.1:<port>.
    pub base: String,
    /// Where its terminal gateway answers (`/term/`): the agent's port + 1 unless the line says.
    pub term_base: String,
    pub tmux_socket: String,
    /// Always true: the agent is on this computer. Kept for the web side's shape.
    pub local: bool,
    pub hue: String,
    #[serde(skip)]
    pub key: String,
}

/// The keys of a desk line kept in computers.json (`cobra-agent desk` prints them).
pub const DESK_LINE_KEYS: [&str; 7] = ["machine", "label", "loopback", "tmuxSocket", "id", "key", "termPort"];

pub struct Store {
    pub dir: PathBuf,
    /// A key rotated since start (api.rs `rotate_key`).
    pub rotated: Mutex<Option<String>>,
}

pub fn here() -> String {
    gethostname::gethostname().to_string_lossy().to_string()
}

/// A name `install.sh --name` takes: letters, digits, `.`, `-` and `_`, 1 to 63 of them.
pub fn is_name(s: &str) -> bool {
    (1..=63).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// The name an agent's `/health` says it goes by: its `name` (the `--name` it was installed
/// with), else its `host` when that is not the hostname the desk keyed it by. None when it says
/// nothing beyond its hostname, so an older agent never undoes the name its desk line carried.
pub fn name_in_health(health: &Value, machine: &str) -> Option<String> {
    let field = |k: &str| health.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|v| is_name(v)).map(String::from);
    field("name").or_else(|| field("host").filter(|h| !h.eq_ignore_ascii_case(machine)))
}

/// What this desktop calls itself (its desk key's name): the name this computer's agent was
/// given, else the hostname.
pub fn own_name(configured: Option<&str>) -> String {
    configured.map(str::trim).filter(|n| is_name(n)).map(String::from).unwrap_or_else(here)
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Store { dir, rotated: Mutex::new(None) }
    }

    pub fn computers_path(&self) -> PathBuf {
        self.dir.join("computers.json")
    }

    /// The kept desk line, as written; None before the agent is linked.
    pub fn entry(&self) -> Option<Value> {
        entry(&self.computers_path())
    }

    pub fn save(&self, entry: &Value) -> Result<(), String> {
        save_private(&self.computers_path(), &json!({ "agent": entry }))
    }

    /// Forget the agent's key here.
    pub fn clear(&self) -> Result<(), String> {
        *self.rotated.lock().unwrap() = None;
        match fs::remove_file(self.computers_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// The agent, when it is linked and its entry is usable.
    pub fn agent(&self) -> Option<Machine> {
        let mut m = machine(&self.entry()?)?;
        m.hue = "blue".into();
        if let Some(k) = self.rotated.lock().unwrap().clone() {
            m.key = k;
        }
        Some(m)
    }

    /// The agent as a list (none or one), the shape the web side reads.
    pub fn load(&self) -> Vec<Machine> {
        self.agent().into_iter().collect()
    }

    /// Call the agent by the name it goes by now. Ok(true) when computers.json changed.
    pub fn set_label(&self, label: &str) -> Result<bool, String> {
        let Some(mut entry) = self.entry() else { return Ok(false) };
        if entry["label"].as_str() == Some(label) {
            return Ok(false);
        }
        entry["label"] = json!(label);
        self.save(&entry)?;
        Ok(true)
    }

    /// Keep a rotated key: written to computers.json first, and used only once
    /// it is there, so a restart never comes back with a key the agent retired.
    pub fn replace_key(&self, old: &str, new: &str) -> Result<(), String> {
        let mut entry = self.entry().filter(|e| e["key"].as_str() == Some(old)).ok_or("the agent is no longer linked with that key")?;
        entry["key"] = json!(new);
        self.save(&entry)?;
        *self.rotated.lock().unwrap() = Some(new.to_string());
        Ok(())
    }

    pub fn pins(&self) -> Vec<String> {
        read_json(&self.dir.join("pins.json"))
            .and_then(|v| v.as_array().cloned())
            .map(|a| a.into_iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default()
    }

    pub fn toggle_pin(&self, key: &str) -> Result<bool, String> {
        let mut found = self.pins();
        let now = !found.iter().any(|k| k == key);
        if now {
            found.push(key.to_string());
        } else {
            found.retain(|k| k != key);
        }
        save_private(&self.dir.join("pins.json"), &json!(found))?;
        Ok(now)
    }

    pub fn settings(&self) -> Value {
        match read_json(&self.dir.join("settings.json")) {
            Some(v @ Value::Object(_)) => v,
            _ => json!({}),
        }
    }

    pub fn set_setting(&self, key: &str, value: Value) -> Result<(), String> {
        let mut s = self.settings();
        s[key] = value;
        save_private(&self.dir.join("settings.json"), &s)
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// computers.json's one entry: `{"agent": {…the desk line…}}`.
pub fn entry(path: &Path) -> Option<Value> {
    read_json(path)?.get("agent").filter(|e| e.is_object()).cloned()
}

fn s(e: &Value, k: &str) -> String {
    e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// The agent's entry, or None when it is not usable. A malformed entry is
/// dropped, never guessed at: the key only ever goes to loopback.
pub fn machine(e: &Value) -> Option<Machine> {
    let name = s(e, "machine");
    let key = s(e, "key");
    if name.is_empty() || key.is_empty() {
        return None;
    }
    let base = s(e, "loopback");
    if !base.starts_with("http://127.0.0.1:") {
        return None;
    }
    let base = base.trim_end_matches('/').to_string();
    // The terminal gateway is on the agent's port + 1 (install.sh's defaults: 8787 and 8788).
    let term = e.get("termPort").and_then(|v| v.as_u64()).or_else(|| base.rsplit(':').next().and_then(|p| p.parse::<u64>().ok()).map(|p| p + 1));
    let term_base = term.map(|p| format!("http://127.0.0.1:{p}")).unwrap_or_default();
    let label = Some(s(e, "label")).filter(|l| !l.is_empty()).unwrap_or_else(|| name.clone());
    let mut title = label.clone();
    if let Some(f) = title.get(0..1) {
        title = f.to_uppercase() + &title[1..];
    }
    Some(Machine {
        machine: name,
        label,
        title,
        base,
        term_base,
        tmux_socket: Some(s(e, "tmuxSocket")).filter(|t| !t.is_empty()).unwrap_or_else(|| crate::host::DEFAULT_TMUX_SOCKET.into()),
        local: true,
        hue: String::new(),
        key,
    })
}

/// Private from the first byte: created 0600 on Unix and replaced in one rename.
pub fn save_private(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())? + "\n";
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The JSON line `cobra-agent desk` prints (apps/agent/src/agent/cli.ts).
pub fn parse_desk_line(stdout: &str) -> Result<Value, String> {
    for line in stdout.trim().lines().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if ["machine", "key", "id", "loopback"].iter().all(|k| v.get(*k).and_then(|x| x.as_str()).is_some_and(|x| !x.is_empty())) {
                return Ok(v);
            }
        }
    }
    Err("the agent did not print a desk key".into())
}

/// The part of a desk line computers.json keeps.
pub fn kept(line: &Value) -> Value {
    let mut entry = json!({});
    for k in DESK_LINE_KEYS {
        if let Some(v) = line.get(k) {
            entry[k] = v.clone();
        }
    }
    entry
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cobra-desk-{name}-{}-{}", std::process::id(), crate::api::new_key()))
    }

    #[test]
    fn the_configured_name_wins_over_the_hostname() {
        assert_eq!(name_in_health(&json!({"host": "omarchy", "name": "laptop"}), "omarchy").as_deref(), Some("laptop"));
        assert_eq!(name_in_health(&json!({"host": "laptop"}), "omarchy").as_deref(), Some("laptop"));
        assert_eq!(name_in_health(&json!({"host": "omarchy"}), "omarchy"), None);
        assert_eq!(name_in_health(&json!({"host": "Omarchy"}), "omarchy"), None);
        assert_eq!(name_in_health(&json!({"ok": true}), "omarchy"), None);
        assert_eq!(name_in_health(&json!({"host": "omarchy", "name": "my box"}), "omarchy"), None);
        assert_eq!(name_in_health(&json!({"host": "omarchy", "name": ""}), "omarchy"), None);
    }

    #[test]
    fn this_desktop_is_named_for_its_agent() {
        assert_eq!(own_name(Some("laptop")), "laptop");
        assert_eq!(own_name(Some(" laptop ")), "laptop");
        assert_eq!(own_name(Some("")), here());
        assert_eq!(own_name(Some("a b")), here());
        assert_eq!(own_name(None), here());
    }

    #[test]
    fn one_agent_kept_private_and_relabelled_in_place() {
        let dir = scratch("label");
        let store = Store::new(dir.clone());
        assert!(store.agent().is_none());
        store.save(&json!({"machine": "omarchy", "label": "omarchy", "key": "k", "id": "d1", "loopback": "http://127.0.0.1:8787"})).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store.computers_path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert!(store.set_label("laptop").unwrap());
        assert!(!store.set_label("laptop").unwrap());
        let m = store.agent().unwrap();
        assert_eq!((m.machine.as_str(), m.label.as_str(), m.title.as_str(), m.key.as_str()), ("omarchy", "laptop", "Laptop", "k"));
        assert_eq!(store.load().len(), 1);
        store.replace_key("k", "k2").unwrap();
        assert!(store.replace_key("k", "k3").is_err());
        assert_eq!(store.agent().unwrap().key, "k2");
        store.clear().unwrap();
        assert!(store.agent().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_key_only_goes_to_loopback() {
        assert!(machine(&json!({"machine": "a", "key": "k", "loopback": "http://evil:1"})).is_none());
        assert!(machine(&json!({"machine": "a", "key": "k", "loopback": "https://a.example.net"})).is_none());
        assert!(machine(&json!({"machine": "a", "loopback": "http://127.0.0.1:8787"})).is_none());
        let m = machine(&json!({"machine": "box", "key": "k", "loopback": "http://127.0.0.1:8787/"})).unwrap();
        assert!(m.local);
        assert_eq!(m.base, "http://127.0.0.1:8787");
        assert_eq!(m.term_base, "http://127.0.0.1:8788");
        let m = machine(&json!({"machine": "box", "key": "k", "loopback": "http://127.0.0.1:8797", "termPort": 9000})).unwrap();
        assert_eq!(m.term_base, "http://127.0.0.1:9000");
        // The web side never gets the key or the desk id.
        let shown = serde_json::to_value(&m).unwrap();
        assert!(shown.get("key").is_none() && shown.get("id").is_none());
    }

    #[test]
    fn desk_line() {
        let out = "noise\n{\"machine\":\"m\",\"key\":\"k\",\"id\":\"i\",\"loopback\":\"http://127.0.0.1:8787\",\"url\":\"https://x\"}\n";
        let line = parse_desk_line(out).unwrap();
        assert_eq!(line["id"], "i");
        assert!(kept(&line).get("url").is_none());
        assert!(parse_desk_line("{}").is_err());
    }
}
