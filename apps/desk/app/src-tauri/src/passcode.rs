//! The desk's own passcode: the check before a hidden value is shown (Show on a dashboard) and before a
//! write that is the person's alone (an expense or a bank file Allowed from its To allow list). The desk has no biometric to ask,
//! so it keeps a passcode of its own: at least 8 characters, kept only as a salted PBKDF2-HMAC-SHA256
//! hash in `passcode.json` (0600) in this app's config folder, never the passcode itself. A right one
//! unlocks the desk for five minutes, five wrong ones in a row
//! lock it out for a minute. The unlock lives here in Rust, so the web side cannot claim to be unlocked:
//! `require` is what `/view/reveal` and the person-only writes pass through (lib.rs `api`, `api_owner`).
//! Forgotten: delete `passcode.json` and set a new one; hidden values stay hidden until then.

use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MIN_LEN: usize = 8;
const ITERATIONS: u32 = 600_000;
const UNLOCK: Duration = Duration::from_secs(5 * 60);
const MAX_FAILS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);

/// PBKDF2-HMAC-SHA256 with a 32-byte result (RFC 8018: one block, so T1 is the whole key).
pub fn pbkdf2(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let base = Hmac::<Sha256>::new_from_slice(password).expect("HMAC takes a key of any length");
    let mut first = base.clone();
    first.update(salt);
    first.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = first.finalize().into_bytes().into();
    let mut t = u;
    for _ in 1..iterations {
        let mut mac = base.clone();
        mac.update(&u);
        u = mac.finalize().into_bytes().into();
        for (a, b) in t.iter_mut().zip(u.iter()) {
            *a ^= b;
        }
    }
    t
}

/// Equal in time that does not depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Default)]
struct Inner {
    unlocked_until: Option<Instant>,
    fails: u32,
    locked_out_until: Option<Instant>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// A passcode has been made.
    pub set: bool,
    /// Unlocked right now.
    pub unlocked: bool,
    /// Seconds of the unlock left.
    pub unlocked_for_s: u64,
    /// Seconds before another try is allowed, after too many wrong ones.
    pub wait_s: u64,
}

pub struct Passcode {
    path: PathBuf,
    iterations: u32,
    unlock_for: Duration,
    lockout: Duration,
    inner: Mutex<Inner>,
}

impl Passcode {
    pub fn new(dir: PathBuf) -> Self {
        Passcode::with(dir.join("passcode.json"), ITERATIONS, UNLOCK, LOCKOUT)
    }

    fn with(path: PathBuf, iterations: u32, unlock_for: Duration, lockout: Duration) -> Self {
        Passcode { path, iterations, unlock_for, lockout, inner: Mutex::new(Inner::default()) }
    }

    fn read(&self) -> Option<(u32, Vec<u8>, Vec<u8>)> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&self.path).ok()?).ok()?;
        let iter = v.get("iter")?.as_u64().filter(|n| (1..=10_000_000).contains(n))? as u32;
        let salt = hex::decode(v.get("salt")?.as_str()?).ok().filter(|s| s.len() >= 8)?;
        let hash = hex::decode(v.get("hash")?.as_str()?).ok().filter(|h| h.len() == 32)?;
        Some((iter, salt, hash))
    }

    pub fn status(&self) -> Status {
        let now = Instant::now();
        let inner = self.inner.lock().unwrap();
        let left = |t: Option<Instant>| t.map(|t| t.saturating_duration_since(now).as_secs_f64().ceil() as u64).unwrap_or(0);
        let unlocked_for_s = left(inner.unlocked_until);
        Status { set: self.path.exists(), unlocked: unlocked_for_s > 0, unlocked_for_s, wait_s: left(inner.locked_out_until) }
    }

    /// Whether `code` is the passcode, counting a wrong one. The error is for the person.
    fn verify(&self, code: &str) -> Result<(), String> {
        let now = Instant::now();
        {
            let inner = self.inner.lock().unwrap();
            if let Some(until) = inner.locked_out_until.filter(|u| *u > now) {
                return Err(format!("Too many wrong tries. Try again in {} seconds.", until.saturating_duration_since(now).as_secs() + 1));
            }
        }
        let Some((iter, salt, hash)) = self.read() else {
            return Err("There is no passcode yet.".into());
        };
        let ok = same(&pbkdf2(code.as_bytes(), &salt, iter), &hash);
        let mut inner = self.inner.lock().unwrap();
        if ok {
            inner.fails = 0;
            inner.locked_out_until = None;
            return Ok(());
        }
        inner.fails += 1;
        if inner.fails >= MAX_FAILS {
            inner.fails = 0;
            inner.locked_out_until = Some(Instant::now() + self.lockout);
            return Err(format!("That is not the passcode. Locked out for {} seconds.", self.lockout.as_secs()));
        }
        Err("That is not the passcode.".into())
    }

    fn unlock_now(&self) {
        self.inner.lock().unwrap().unlocked_until = Some(Instant::now() + self.unlock_for);
    }

    /// Makes the passcode, or changes it (`old` is then the one in force). Unlocks, since the person just proved it.
    pub fn set(&self, new: &str, old: Option<&str>) -> Result<(), String> {
        if new.chars().count() < MIN_LEN {
            return Err(format!("A passcode is at least {MIN_LEN} characters."));
        }
        if self.path.exists() {
            self.verify(old.ok_or("Type the current passcode to change it.")?)?;
        }
        let salt: [u8; 16] = rand::random();
        let hash = pbkdf2(new.as_bytes(), &salt, self.iterations);
        crate::computers::save_private(&self.path, &json!({ "v": 1, "iter": self.iterations, "salt": hex::encode(salt), "hash": hex::encode(hash) }))?;
        self.unlock_now();
        Ok(())
    }

    pub fn unlock(&self, code: &str) -> Result<(), String> {
        self.verify(code)?;
        self.unlock_now();
        Ok(())
    }

    pub fn lock(&self) {
        self.inner.lock().unwrap().unlocked_until = None;
    }

    /// Takes the passcode away, given the right one. Hidden values then stay hidden until a new one is made.
    pub fn clear(&self, code: &str) -> Result<(), String> {
        self.verify(code)?;
        std::fs::remove_file(&self.path).map_err(|e| e.to_string())?;
        self.lock();
        Ok(())
    }

    /// Passes only while unlocked: what a hidden value or a person-only write goes through.
    pub fn require(&self) -> Result<(), String> {
        let st = self.status();
        if st.unlocked {
            Ok(())
        } else if !st.set {
            Err("Make a passcode first (Settings → This app).".into())
        } else {
            Err("Locked. Type your passcode.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cobra-passcode-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn quick(name: &str) -> Passcode {
        Passcode::with(dir(name).join("passcode.json"), 1000, Duration::from_secs(300), Duration::from_secs(60))
    }

    #[test]
    fn pbkdf2_matches_the_published_vectors() {
        // RFC 7914 section 11 (PBKDF2-HMAC-SHA-256), first 32 bytes.
        assert_eq!(hex::encode(pbkdf2(b"passwd", b"salt", 1)), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
        assert_eq!(hex::encode(pbkdf2(b"Password", b"NaCl", 80000)), "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56");
    }

    #[test]
    fn a_passcode_is_made_kept_as_a_hash_and_unlocks() {
        let p = quick("make");
        assert_eq!(p.status(), Status { set: false, unlocked: false, unlocked_for_s: 0, wait_s: 0 });
        assert!(p.require().unwrap_err().contains("Make a passcode"));
        assert!(p.set("short", None).unwrap_err().contains("at least 8"));
        p.set("correct horse battery", None).unwrap();
        // Making it unlocks; the file holds the hash and never the passcode.
        assert!(p.status().set && p.status().unlocked);
        assert!(p.require().is_ok());
        let kept = std::fs::read_to_string(&p.path).unwrap();
        assert!(!kept.contains("correct horse"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p.path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        p.lock();
        assert!(p.require().unwrap_err().contains("Locked"));
        assert!(p.unlock("wrong passcode").is_err());
        assert!(p.require().is_err());
        p.unlock("correct horse battery").unwrap();
        assert!(p.require().is_ok());
    }

    #[test]
    fn changing_and_removing_it_need_the_one_in_force() {
        let p = quick("change");
        p.set("first passcode", None).unwrap();
        assert!(p.set("second passcode", None).unwrap_err().contains("current passcode"));
        assert!(p.set("second passcode", Some("not it at all")).is_err());
        p.set("second passcode", Some("first passcode")).unwrap();
        p.lock();
        assert!(p.unlock("first passcode").is_err());
        p.unlock("second passcode").unwrap();
        assert!(p.clear("nope nope nope").is_err());
        p.clear("second passcode").unwrap();
        assert!(!p.status().set && !p.status().unlocked);
    }

    #[test]
    fn five_wrong_tries_in_a_row_lock_it_out_even_for_the_right_one() {
        let p = quick("lockout");
        p.set("right passcode", None).unwrap();
        p.lock();
        for i in 1..MAX_FAILS {
            assert_eq!(p.unlock("wrong one!!").unwrap_err(), "That is not the passcode.", "try {i}");
        }
        assert!(p.unlock("wrong one!!").unwrap_err().contains("Locked out"));
        assert!(p.status().wait_s > 0);
        assert!(p.unlock("right passcode").unwrap_err().contains("Too many wrong tries"));
        assert!(p.require().is_err());
    }

    #[test]
    fn an_unlock_runs_out() {
        let p = Passcode::with(dir("expire").join("passcode.json"), 1000, Duration::from_millis(0), Duration::from_secs(60));
        p.set("right passcode", None).unwrap();
        assert!(!p.status().unlocked);
        assert!(p.require().is_err());
    }

    #[test]
    fn a_damaged_file_is_no_passcode_and_never_opens() {
        let p = quick("damaged");
        std::fs::write(&p.path, "{\"v\":1,\"iter\":0,\"salt\":\"zz\",\"hash\":\"\"}").unwrap();
        assert!(p.unlock("anything at all").unwrap_err().contains("no passcode"));
    }
}
