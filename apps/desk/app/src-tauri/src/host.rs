//! This computer: running programs, and where the agent is.
//!
//! The agent runs on this computer, put there by its own `install.sh`:
//! `~/.local/bin/cobra-agent`, run by a systemd user unit on Linux, its port
//! and tmux socket in `~/.config/cobra-agent/agent.env`. The desk only ever
//! talks to it on loopback.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

pub const AGENT: &str = "~/.local/bin/cobra-agent";
/// The agent's port when agent.env does not say (its install.sh's default).
pub const DEFAULT_PORT: u16 = 8787;
/// The agent's tmux socket when agent.env does not say (`tmux -L cobra`).
pub const DEFAULT_TMUX_SOCKET: &str = "cobra";
/// The agent's systemd user unit on Linux.
pub const AGENT_UNIT: &str = "cobra-agent";

/// What the agent's install.sh wrote to `~/.config/cobra-agent/agent.env`
/// that this desktop needs: where the agent answers, which tmux server
/// its sessions live on, and the name it was given (`install.sh --name`).
#[derive(Clone, Debug, PartialEq)]
pub struct AgentEnv {
    pub port: u16,
    pub tmux_socket: String,
    /// COBRA_MACHINE_NAME; empty when it was not given one (the hostname is its name then).
    pub name: String,
}

impl Default for AgentEnv {
    fn default() -> Self {
        AgentEnv { port: DEFAULT_PORT, tmux_socket: DEFAULT_TMUX_SOCKET.into(), name: String::new() }
    }
}

/// agent.env is a KEY=VALUE file read by systemd (`EnvironmentFile`) and by
/// `set -a; . agent.env` in shells: comments, blank lines, an optional
/// `export`, and values that may be quoted. A malformed port keeps the
/// default rather than pointing at a port nobody listens on.
pub fn parse_agent_env(text: &str) -> AgentEnv {
    let mut env = AgentEnv::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        match key.trim() {
            "COBRA_AGENT_PORT" => {
                if let Ok(p) = value.parse::<u16>() {
                    if p > 0 {
                        env.port = p;
                    }
                }
            }
            "COBRA_TMUX_SOCKET" => {
                if !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    env.tmux_socket = value.to_string();
                }
            }
            "COBRA_MACHINE_NAME" => {
                if crate::computers::is_name(value) {
                    env.name = value.to_string();
                }
            }
            _ => {}
        }
    }
    env
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|h| !h.as_os_str().is_empty())
}

/// `~/.config/cobra-agent/agent.env`, honouring XDG_CONFIG_HOME as the agent does.
pub fn agent_env_path() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty());
    let config = config.or_else(|| home().map(|h| h.join(".config")))?;
    Some(config.join("cobra-agent").join("agent.env"))
}

/// This computer's agent.env, or the defaults when there is none (the agent
/// is not installed, or this is not Linux).
pub fn read_agent_env() -> AgentEnv {
    agent_env_path().and_then(|p| std::fs::read_to_string(p).ok()).map(|t| parse_agent_env(&t)).unwrap_or_default()
}

/// Where the agent's CLI may be on this computer: the symlink install.sh
/// makes, then the versioned install it points into.
pub fn agent_candidates() -> Vec<PathBuf> {
    let Some(h) = home() else { return vec![] };
    vec![h.join(".local/bin/cobra-agent"), h.join(".local/share/cobra-agent/current/bin/cobra-agent")]
}

/// The agent's CLI on this computer, when one of the candidates is executable.
#[cfg(unix)]
pub fn local_agent() -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    agent_candidates().into_iter().find(|p| std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false))
}

#[cfg(not(unix))]
pub fn local_agent() -> Option<PathBuf> {
    None
}

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A program run with no window, its output captured, killed after `timeout`.
pub async fn run(program: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => Ok(Output {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).replace('\0', ""),
            stderr: String::from_utf8_lossy(&out.stderr).replace('\0', ""),
        }),
        Ok(Err(e)) => Err(format!("{program}: {e}")),
        Err(_) => Err(format!("{program} took longer than {}s", timeout.as_secs())),
    }
}

/// Single-quoted for /bin/sh.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `cobra-agent <args>` on this computer.
pub async fn run_agent(args: &[&str]) -> Result<Output, String> {
    let quoted = args.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
    // The CLI may only exist at its versioned path.
    let bin = local_agent().map(|p| sh_quote(&p.to_string_lossy())).unwrap_or_else(|| AGENT.to_string());
    run("/bin/sh", &["-c", &format!("{bin} {quoted}")], Duration::from_secs(60)).await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostState {
    pub os: String,
    pub hostname: String,
    /// `~/.local/bin/cobra-agent` exists.
    pub agent_installed: bool,
    /// Where it was looked for (or found): what the Setup page shows.
    pub agent_path: String,
    /// The port its agent.env names (8787 when it does not).
    pub agent_port: u16,
    /// The tmux socket its agent.env names (`cobra` when it does not).
    pub tmux_socket: String,
    /// Linux: `systemctl --user is-active cobra-agent`. None elsewhere.
    pub agent_service: Option<bool>,
    /// Something answers on http://127.0.0.1:<agent_port>/health.
    pub agent_answering: bool,
}

pub async fn host_state() -> HostState {
    let env = read_agent_env();
    let mut s = HostState {
        os: std::env::consts::OS.into(),
        hostname: crate::computers::here(),
        agent_path: AGENT.into(),
        agent_port: env.port,
        tmux_socket: env.tmux_socket,
        ..Default::default()
    };
    match local_agent() {
        Some(p) => {
            s.agent_installed = true;
            s.agent_path = p.to_string_lossy().into_owned();
        }
        None => {
            s.agent_path = agent_candidates().first().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| AGENT.into());
        }
    }
    if cfg!(target_os = "linux") {
        s.agent_service = Some(
            run("systemctl", &["--user", "is-active", "--quiet", AGENT_UNIT], Duration::from_secs(5)).await.map(|o| o.code == 0).unwrap_or(false),
        );
    }
    s.agent_answering = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/health", s.agent_port))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .is_ok();
    s
}

/// Linux: `cobra-launch` (apps/desk/omarchy/bin), which opens a real terminal
/// on a session's tmux: beside this binary (the installer puts both in
/// ~/.local/bin), then in ~/.local/bin, then, for a dev build, in the checkout.
pub fn launcher() -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let mut found = vec![];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            found.push(dir.join("cobra-launch"));
        }
    }
    if let Some(h) = home() {
        found.push(h.join(".local/bin/cobra-launch"));
    }
    if cfg!(debug_assertions) {
        found.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../omarchy/bin/cobra-launch"));
    }
    found.into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn agent_env_is_read_as_a_shell_would() {
        let env = parse_agent_env("# the agent\nCOBRA_AGENT_PORT=8797\nCOBRA_TERM_PORT=8798\nCOBRA_TMUX_SOCKET=default\nPATH=/usr/bin\n");
        assert_eq!(env, AgentEnv { port: 8797, tmux_socket: "default".into(), name: String::new() });
        let env = parse_agent_env("export COBRA_AGENT_PORT=\"9001\"\nCOBRA_TMUX_SOCKET='cobra-2'\nCOBRA_MACHINE_NAME=legion\n");
        assert_eq!(env, AgentEnv { port: 9001, tmux_socket: "cobra-2".into(), name: "legion".into() });
    }

    #[test]
    fn agent_env_defaults() {
        assert_eq!(parse_agent_env(""), AgentEnv { port: 8787, tmux_socket: "cobra".into(), name: String::new() });
        // A name install.sh would not have written is not one.
        assert_eq!(parse_agent_env("COBRA_MACHINE_NAME=my box\n").name, "");
        assert_eq!(parse_agent_env("COBRA_MACHINE_NAME=\n").name, "");
        // A port that is not one, or a socket name tmux could not take, keeps the default.
        let env = parse_agent_env("COBRA_AGENT_PORT=eight\nCOBRA_TMUX_SOCKET=a b\n");
        assert_eq!(env, AgentEnv::default());
        assert_eq!(parse_agent_env("COBRA_AGENT_PORT=0").port, 8787);
        assert_eq!(parse_agent_env("COBRA_AGENT_PORT=70000").port, 8787);
        // Not an assignment: ignored, not a crash.
        assert_eq!(parse_agent_env("COBRA_AGENT_PORT\n=\n"), AgentEnv::default());
    }
}
