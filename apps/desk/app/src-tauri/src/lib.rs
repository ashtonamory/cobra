//! Cobra's desk: the desktop app for the one agent on this computer, on Linux
//! (Omarchy) and macOS. It talks only to that agent, on loopback.
//!
//! One process. The main window holds the poller (src/lib/fleet.ts) and is
//! hidden, never closed, so notifications keep coming; the picker and the
//! needs-you popup are their own small windows fed by its events. The tray
//! (Linux) or menu-bar icon (macOS) is the bar widget; on Omarchy the bar
//! also shows a count (bar_state.rs).

mod api;
mod bar_state;
mod computers;
mod design;
mod host;
mod pages;
mod passcode;

use computers::{Machine, Store};

/// The product's name wherever a person reads it from this side: the windows' titles, the tray,
/// messages. The web side has its own (src/lib/appName.ts); a build under another name changes
/// both, and the titles in apps/desk/omarchy/hypr/cobra.lua. Never an identifier: the bundle id,
/// the config folder and the binary keep their names.
macro_rules! app_name {
    () => {
        "Cobra"
    };
}
pub const APP_NAME: &str = app_name!();
/// The assistant's name (the Lead) where this side says it: the tray's "Message …". The web side's
/// is LEAD_NAME in src/lib/appName.ts. One place, so a name the person picks can replace it later.
pub const LEAD_NAME: &str = app_name!();
fn lead_name() -> &'static str {
    LEAD_NAME
}
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct App {
    store: Store,
    api: api::Api,
    /// The check before a hidden value is shown or a person-only write is made (passcode.rs).
    passcode: Arc<passcode::Passcode>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The agent, by the name the web side passes (its hostname, as /projects reports it).
fn machine(app: &App, name: &str) -> Result<Machine, api::ApiError> {
    match app.store.agent() {
        Some(m) if m.machine == name => Ok(m),
        Some(_) => Err(api::ApiError::new(0, format!("{name} is not this computer's agent"))),
        None => Err(api::ApiError::new(0, "The agent on this computer is not linked yet.")),
    }
}

// -- the agents ------------------------------------------------------------------

#[tauri::command]
fn computers(app: State<'_, App>) -> Vec<Machine> {
    app.store.load()
}

#[tauri::command]
async fn api(
    app: State<'_, App>,
    machine: String,
    method: String,
    path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, api::ApiError> {
    // A hidden value is only ever read behind the passcode, whoever asks.
    if path.starts_with("/view/reveal") {
        app.passcode.require().map_err(|e| api::ApiError::new(403, e))?;
    }
    let m = self::machine(&app, &machine)?;
    app.api.request(&app.store, &m, &method, &path, body, timeout_ms.unwrap_or(4000)).await
}

/// `api` for a write that is the person's alone (a trade's `personOnly` mutation): only while unlocked.
#[tauri::command]
async fn api_owner(
    app: State<'_, App>,
    machine: String,
    method: String,
    path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, api::ApiError> {
    app.passcode.require().map_err(|e| api::ApiError::new(403, e))?;
    let m = self::machine(&app, &machine)?;
    app.api.request(&app.store, &m, &method, &path, body, timeout_ms.unwrap_or(10000)).await
}

#[tauri::command]
fn passcode_status(app: State<'_, App>) -> passcode::Status {
    app.passcode.status()
}

/// Makes the passcode, or changes it (`old` is the one in force).
#[tauri::command]
async fn passcode_set(app: State<'_, App>, new: String, old: Option<String>) -> Result<(), String> {
    // 600,000 rounds of hashing: not on the thread that draws the window.
    let handle = app.inner().passcode.clone();
    tauri::async_runtime::spawn_blocking(move || handle.set(&new, old.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn passcode_unlock(app: State<'_, App>, code: String) -> Result<(), String> {
    let handle = app.inner().passcode.clone();
    tauri::async_runtime::spawn_blocking(move || handle.unlock(&code)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn passcode_lock(app: State<'_, App>) {
    app.passcode.lock();
}

#[tauri::command]
async fn passcode_clear(app: State<'_, App>, code: String) -> Result<(), String> {
    let handle = app.inner().passcode.clone();
    tauri::async_runtime::spawn_blocking(move || handle.clear(&code)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn api_upload(app: State<'_, App>, machine: String, path: String, file: String) -> Result<Value, api::ApiError> {
    let m = self::machine(&app, &machine)?;
    let bytes = tokio::fs::read(&file).await.map_err(|e| api::ApiError::new(0, format!("{file}: {e}")))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err(api::ApiError::new(0, "That image is over 20 MB."));
    }
    app.api.upload(&m, &path, bytes).await
}

/// The most a shown design may weigh, as the agent's own cap (designer.ts).
const DESIGN_BYTES: usize = 20 * 1024 * 1024;

/// A design a Designer showed in the Lead's thread: the PNG from the hub, checked to be one.
async fn design_bytes(app: &App, machine: &str, path: &str) -> Result<Vec<u8>, api::ApiError> {
    let m = self::machine(app, machine)?;
    let bytes = app.api.download(&m, path, DESIGN_BYTES).await?;
    if !design::is_png(&bytes) {
        return Err(api::ApiError::new(0, "That design is not a PNG."));
    }
    Ok(bytes)
}

/// A shown design, or a website card's screenshot (a JPEG), as a `data:` URL the page can draw.
#[tauri::command]
async fn design_image(app: State<'_, App>, machine: String, path: String) -> Result<String, api::ApiError> {
    use base64::Engine;
    let m = self::machine(&app, &machine)?;
    let bytes = app.api.download(&m, &path, DESIGN_BYTES).await?;
    let Some(kind) = design::image_type(&bytes) else {
        return Err(api::ApiError::new(0, "That is not a PNG or JPEG image."));
    };
    Ok(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A shown design saved into Pictures/Cobra (Downloads when there is no Pictures folder),
/// never over a file there. Returns where it went.
#[tauri::command]
async fn design_save(handle: AppHandle, app: State<'_, App>, machine: String, path: String, name: String) -> Result<String, api::ApiError> {
    let bytes = design_bytes(&app, &machine, &path).await?;
    let base = handle.path().picture_dir().or_else(|_| handle.path().download_dir()).map_err(|e| api::ApiError::new(0, e.to_string()))?;
    let folder = base.join(APP_NAME);
    tokio::fs::create_dir_all(&folder).await.map_err(|e| api::ApiError::new(0, format!("{}: {e}", folder.display())))?;
    let mut n = 1;
    loop {
        let target = folder.join(design::file_name(&name, n));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(&bytes).map_err(|e| api::ApiError::new(0, format!("{}: {e}", target.display())))?;
                return Ok(target.display().to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 100 => n += 1,
            Err(e) => return Err(api::ApiError::new(0, format!("{}: {e}", target.display()))),
        }
    }
}

// -- this desktop's files ------------------------------------------------------------

#[tauri::command]
fn pins(app: State<'_, App>) -> Vec<String> {
    app.store.pins()
}

#[tauri::command]
fn toggle_pin(app: State<'_, App>, key: String) -> Result<bool, String> {
    app.store.toggle_pin(&key)
}

#[tauri::command]
fn settings(app: State<'_, App>) -> Value {
    app.store.settings()
}

#[tauri::command]
fn set_setting(app: State<'_, App>, key: String, value: Value) -> Result<(), String> {
    app.store.set_setting(&key, value)
}

// -- linking the agent ---------------------------------------------------------------

/// What this computer is called: the name its agent was installed with (`install.sh --name`,
/// COBRA_MACHINE_NAME in agent.env, or what its /health says), else the hostname.
async fn this_name() -> String {
    let env = host::read_agent_env();
    if !env.name.is_empty() {
        return computers::own_name(Some(&env.name));
    }
    let health = async {
        let reply = reqwest::Client::new().get(format!("http://127.0.0.1:{}/health", env.port)).timeout(Duration::from_secs(2)).send().await.ok()?;
        reply.json::<Value>().await.ok()
    };
    let said = health.await.and_then(|h| computers::name_in_health(&h, &computers::here()));
    computers::own_name(said.as_deref())
}

/// The name a desk key made for this desktop carries (`cobra-agent desk --name`).
#[tauri::command]
async fn desk_name() -> String {
    format!("{} desktop", this_name().await)
}

/// Ask the agent what it goes by (/health) and keep a new name as its label, so an agent
/// installed with `--name laptop` reads "laptop", not its hostname. Whether it was renamed.
#[tauri::command]
async fn learn_names(app: State<'_, App>) -> Result<usize, String> {
    let Some(m) = app.store.agent() else { return Ok(0) };
    let Ok(health) = app.api.request(&app.store, &m, "GET", "/health", None, 3000).await else { return Ok(0) };
    match computers::name_in_health(&health, &m.machine).filter(|n| *n != m.label) {
        Some(name) => Ok(app.store.set_label(&name)? as usize),
        None => Ok(0),
    }
}

/// Ask this computer's agent for a desk key (`cobra-agent desk`) and keep it. Linking again
/// replaces the key and revokes the old one.
#[tauri::command]
async fn link_agent(app: State<'_, App>) -> Result<String, String> {
    let name = desk_name().await;
    let done = host::run_agent(&["desk", "--name", &name]).await?;
    if done.code != 0 {
        return Err(Some(done.stderr.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or(format!("cobra-agent desk failed (exit {})", done.code)));
    }
    let line = computers::parse_desk_line(&done.stdout).map_err(|e| format!("{e}. Is the agent new enough to know `desk`?"))?;
    let entry = computers::kept(&line);
    if computers::machine(&entry).is_none() {
        return Err("The agent's desk line has no loopback address this desktop can use.".into());
    }
    let old = app.store.entry();
    app.store.save(&entry)?;
    *app.store.rotated.lock().unwrap() = None;
    let label = entry["label"].as_str().or(entry["machine"].as_str()).unwrap_or("?").to_string();
    let mut said = format!("Linked {label}.");
    if let Some(old_id) = old.as_ref().and_then(|o| o["id"].as_str()).filter(|id| !id.is_empty() && *id != entry["id"].as_str().unwrap_or("")) {
        let revoked = host::run_agent(&["unlink", old_id]).await;
        if !matches!(revoked, Ok(ref o) if o.code == 0) {
            said += &format!(" Could not revoke its old key {old_id}.");
        }
    }
    Ok(said)
}

/// Revoke this desktop's key on the agent and forget it here.
#[tauri::command]
async fn unlink_agent(app: State<'_, App>) -> Result<String, String> {
    let Some(entry) = app.store.entry() else { return Ok("Nothing was linked.".into()) };
    let id = entry["id"].as_str().unwrap_or("").to_string();
    let mut said = "Unlinked the agent.".to_string();
    match host::run_agent(&["unlink", &id]).await {
        Ok(o) if o.code == 0 => {}
        _ => said += &format!(" Could not revoke its key: run `cobra-agent unlink {id}`."),
    }
    app.store.clear()?;
    Ok(said)
}

// -- the host ----------------------------------------------------------------------------

#[tauri::command]
async fn host_state() -> Result<host::HostState, ()> {
    Ok(host::host_state().await)
}

// -- windows and the tray ---------------------------------------------------------------------

#[tauri::command]
fn show_main(handle: AppHandle, page: Option<String>) {
    show_main_window(&handle, page.as_deref());
}

fn show_main_window(handle: &AppHandle, page: Option<&str>) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        bring_here();
        if let Some(p) = page {
            let _ = handle.emit_to("main", "navigate", p);
        }
    }
}

/// Under Hyprland a window shown from the bar or SUPER+P may sit on another
/// workspace: `set_focus` is an activation request, which the compositor
/// honours for focus but not by switching workspaces, so the person sees
/// nothing happen. The Python desk never had this, drawing on a layer above
/// every workspace. So: move the main window to the current workspace, then
/// focus it. Both are no-ops anywhere but a live Hyprland session.
/// Hyprland honours an activation request for focus but not always for the
/// window that was just mapped from a bind; naming it to `focuswindow` does.
#[cfg(target_os = "linux")]
fn focus_on_hyprland(title: &'static str) {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        let _ = std::process::Command::new("hyprctl").args(["dispatch", "focuswindow", &format!("title:^({title})$")]).output();
    });
}

#[cfg(not(target_os = "linux"))]
fn focus_on_hyprland(_title: &'static str) {}

#[cfg(target_os = "linux")]
fn bring_here() {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
        return;
    }
    std::thread::spawn(|| {
        let ws = std::process::Command::new("hyprctl").args(["activeworkspace", "-j"]).output().ok()
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
            .and_then(|v| v.get("id").and_then(|i| i.as_i64()));
        if let Some(ws) = ws {
            let _ = std::process::Command::new("hyprctl").args(["dispatch", "movetoworkspacesilent", &format!("{ws},title:^({APP_NAME})$")]).output();
        }
        let _ = std::process::Command::new("hyprctl").args(["dispatch", "focuswindow", &format!("title:^({APP_NAME})$")]).output();
    });
}

#[cfg(not(target_os = "linux"))]
fn bring_here() {}

#[tauri::command]
fn toggle_picker(handle: AppHandle) {
    toggle_picker_window(&handle);
}

/// The small windows' titles: what a Hyprland window rule matches them by
/// (apps/desk/omarchy/hypr/cobra.lua), with the class `cobra-desktop`. Their
/// decorations are off, so nobody reads them otherwise.
pub const PICKER_TITLE: &str = concat!(app_name!(), " picker");
pub const POPUP_TITLE: &str = concat!(app_name!(), " needs you");
pub const BOX_TITLE: &str = concat!(app_name!(), " box");

/// When the picker was last shown. It hides on losing focus, and under
/// Hyprland a window shown from a key bind gets a focus-out while it maps,
/// which hid it in the same instant it opened; a focus-out that soon after
/// showing is ignored.
static PICKER_SHOWN_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
const PICKER_SETTLE: Duration = Duration::from_millis(600);

fn picker_just_shown() -> bool {
    PICKER_SHOWN_AT.lock().unwrap().is_some_and(|t| t.elapsed() < PICKER_SETTLE)
}

fn toggle_picker_window(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("picker") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.center();
            *PICKER_SHOWN_AT.lock().unwrap() = Some(std::time::Instant::now());
            let _ = w.show();
            let _ = w.set_focus();
            focus_on_hyprland(PICKER_TITLE);
            let _ = handle.emit_to("picker", "picker-opened", ());
        }
        return;
    }
    *PICKER_SHOWN_AT.lock().unwrap() = Some(std::time::Instant::now());
    let _ = WebviewWindowBuilder::new(handle, "picker", WebviewUrl::App("index.html?surface=picker".into()))
        .title(PICKER_TITLE)
        .inner_size(640.0, 460.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .accept_first_mouse(true)
        .build();
}

#[tauri::command]
fn toggle_box(handle: AppHandle) {
    toggle_box_window(&handle);
}

/// The Lead box (surfaces/CobraBox.tsx): a small panel in the middle of the
/// screen to message the Lead from anywhere, shown and hidden by SUPER+SHIFT+J
/// (`cobra-desktop box`) or Ctrl+Shift+J. Unlike the picker it stays up
/// when it loses focus, so the answer can be watched while you work; Esc
/// hides it.
fn toggle_box_window(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("box") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.center();
            let _ = w.show();
            let _ = w.set_focus();
            focus_on_hyprland(BOX_TITLE);
            let _ = handle.emit_to("box", "box-opened", ());
        }
        return;
    }
    let _ = WebviewWindowBuilder::new(handle, "box", WebviewUrl::App("index.html?surface=box".into()))
        .title(BOX_TITLE)
        .inner_size(560.0, 440.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .accept_first_mouse(true)
        .build();
}

/// The needs-you popups: a column at the screen's top right, over everything,
/// never taking focus. `height` is what its cards need (0 hides it). Under
/// Wayland a window cannot place itself: the Hyprland rule in
/// apps/desk/omarchy/hypr/cobra.lua floats it at the top right when it maps,
/// and only the size set here takes.
#[tauri::command]
fn popup_layout(handle: AppHandle, height: f64) {
    let w = match handle.get_webview_window("popup") {
        Some(w) => w,
        None => return,
    };
    if height <= 0.0 {
        let _ = w.hide();
        return;
    }
    let width = 400.0;
    let monitor = w.primary_monitor().ok().flatten().or_else(|| w.current_monitor().ok().flatten());
    if let Some(mon) = monitor {
        let scale = mon.scale_factor();
        let area = mon.work_area();
        let max_h = area.size.height as f64 / scale - 24.0;
        let h = height.min(max_h);
        let _ = w.set_size(tauri::LogicalSize::new(width, h));
        let x = area.position.x + area.size.width as i32 - ((width + 12.0) * scale) as i32;
        let y = area.position.y + (12.0 * scale) as i32;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    if !w.is_visible().unwrap_or(false) {
        let _ = w.show();
    }
}

/// The tray's numbers, on every change of the poll. On Linux they also go
/// to the bar widget's state file (bar_state.rs) each time, clock included,
/// so the bar can tell a quiet desktop from one that stopped.
#[tauri::command]
fn set_tray(handle: AppHandle, needs: u32, working: u32, alerts: u32) {
    if cfg!(target_os = "linux") {
        if let Some(path) = bar_state::path() {
            let state = bar_state::BarState { needs_you: needs, working, alerts, updated_at: now_ms() };
            if let Err(e) = bar_state::write(&path, &state) {
                eprintln!("cobra-desktop: could not write {}: {e}", path.display());
            }
        }
    }
    if let Some(tray) = handle.tray_by_id("cobra") {
        let mut tip = format!("{APP_NAME} · {needs} need you · {working} working");
        if alerts > 0 {
            tip += &format!(" · {alerts} alerts");
        }
        let _ = tray.set_tooltip(Some(&tip));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(if needs > 0 { Some(needs.to_string()) } else { None });
    }
    if let Some(w) = handle.get_webview_window("main") {
        // The Dock's badge on macOS.
        let _ = w.set_badge_count(if needs > 0 { Some(needs as i64) } else { None });
    }
}

#[tauri::command]
fn quit(handle: AppHandle) {
    handle.exit(0);
}

fn build_tray(handle: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(handle, "open", format!("Open {APP_NAME}"), true, None::<&str>)?;
    let pick = MenuItem::with_id(handle, "pick", "Find a session…", true, None::<&str>)?;
    let lead = MenuItem::with_id(handle, "box", format!("Message {}…", lead_name()), true, None::<&str>)?;
    let ops = MenuItem::with_id(handle, "ops", "Home", true, None::<&str>)?;
    let agents = MenuItem::with_id(handle, "agents", "My Organization", true, None::<&str>)?;
    let quit = MenuItem::with_id(handle, "quit", format!("Quit {APP_NAME}"), true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(handle)?;
    let sep2 = PredefinedMenuItem::separator(handle)?;
    let menu = Menu::with_items(handle, &[&open, &pick, &lead, &sep, &ops, &agents, &sep2, &quit])?;
    TrayIconBuilder::with_id("cobra")
        .icon(handle.default_window_icon().cloned().expect("an app icon"))
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(APP_NAME)
        .menu(&menu)
        // A Linux tray (StatusNotifierItem through appindicator) delivers no
        // click to the app, only its menu; so there a left click opens the
        // menu, whose first item is the window. Elsewhere a left click is
        // the window itself and the menu stays on the right button.
        .show_menu_on_left_click(cfg!(target_os = "linux"))
        .on_menu_event(|h, e| match e.id.as_ref() {
            "open" => show_main_window(h, None),
            "pick" => toggle_picker_window(h),
            "box" => toggle_box_window(h),
            "quit" => h.exit(0),
            page => show_main_window(h, Some(page)),
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main_window(tray.app_handle(), None);
            }
        })
        .build(handle)?;
    Ok(())
}

/// On macOS: ⌘⇧Space opens the picker. On Linux Wayland lets no app take a
/// global key, so SUPER+P is a Hyprland bind to `cobra-desktop pick`
/// (apps/desk/omarchy/hypr), which the single-instance plugin turns into the
/// same toggle; the shortcut plugin is not even loaded there.
const PICKER_SHORTCUT: &str = "CommandOrControl+Shift+Space";
/// The Lead box's, the same way: SUPER+SHIFT+J on Omarchy, this elsewhere.
const BOX_SHORTCUT: &str = "CommandOrControl+Shift+J";

/// What a launch asks for, from its arguments. The first launch does it on
/// start; a later one (the bar, SUPER+P, a notification) is
/// forwarded to the running app by the single-instance plugin and exits.
#[derive(Debug, PartialEq)]
enum Launch {
    /// `cobra-desktop`, `cobra-desktop ops|agents|projects|settings`, or the
    /// desk's `show [page]`: the main window, on that page.
    Show(Option<String>),
    /// `cobra-desktop pick`: the picker.
    Pick,
    /// `cobra-desktop box`: the Lead box.
    Box,
    /// `cobra-desktop --hidden`: run in the tray (the systemd unit); nothing shown.
    Hidden,
}

// "home" is Home's new name; the page itself is still keyed "ops", which the web side maps it to.
const PAGES: [&str; 7] = ["ops", "home", "agents", "projects", "money", "notebook", "settings"];

fn launch_request(argv: &[String]) -> Launch {
    let words: Vec<&str> = argv.iter().skip(1).map(String::as_str).filter(|a| !a.starts_with('-')).collect();
    match words.first().copied() {
        Some("pick") => Launch::Pick,
        Some("box") => Launch::Box,
        Some("show") => Launch::Show(words.get(1).filter(|p| PAGES.contains(p)).map(|p| p.to_string())),
        Some(page) if PAGES.contains(&page) => Launch::Show(Some(page.to_string())),
        Some(_) => Launch::Show(None),
        None if argv.iter().any(|a| a == "--hidden") => Launch::Hidden,
        None => Launch::Show(None),
    }
}

fn act_on(app: &AppHandle, launch: Launch) {
    match launch {
        Launch::Pick => toggle_picker_window(app),
        Launch::Box => toggle_box_window(app),
        Launch::Show(page) => show_main_window(app, page.as_deref()),
        Launch::Hidden => {}
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (the Start menu, a notification, SUPER+P) drives the first.
            act_on(app, launch_request(&argv));
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The desk's own updates: each is checked against the public key in tauri.conf.json before it installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // No window leaves Cobra's own page: a web link opens in the browser (pages.rs).
        .plugin(pages::guard())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])));
    let builder = if cfg!(target_os = "linux") {
        builder
    } else {
        builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if BOX_SHORTCUT.parse::<Shortcut>().is_ok_and(|key| &key == shortcut) {
                        toggle_box_window(app);
                    } else {
                        toggle_picker_window(app);
                    }
                })
                .build(),
        )
    };
    builder
        .setup(|app| {
            let dir = app.path().app_config_dir().expect("a config folder");
            let state = App { store: Store::new(dir.clone()), api: api::Api::new(), passcode: Arc::new(passcode::Passcode::new(dir)) };
            app.manage(state);
            // The main window's title is the name a person reads (tauri.conf.json starts it the same).
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(APP_NAME);
            }
            build_tray(app.handle())?;
            if !cfg!(target_os = "linux") {
                for key in [PICKER_SHORTCUT, BOX_SHORTCUT] {
                    if let Err(e) = app.global_shortcut().register(key) {
                        eprintln!("cobra-desktop: could not take {key}: {e}");
                    }
                }
            }
            // The popup column, made hidden now so the first needs-you is instant.
            WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("index.html?surface=popup".into()))
                .title(POPUP_TITLE)
                .inner_size(400.0, 200.0)
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .accept_first_mouse(true)
                .visible(false)
                .build()?;
            // The first launch: the window (on a page), the picker, or nothing (`--hidden`, service mode).
            act_on(app.handle(), launch_request(&std::env::args().collect::<Vec<_>>()));
            // The poller's clock, from here rather than a page timer: a hidden
            // webview's timers are throttled, events are not.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut every = tokio::time::interval(Duration::from_secs(1));
                loop {
                    every.tick().await;
                    let _ = handle.emit_to("main", "tick", ());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window or the picker hides it: the app keeps
            // running in the tray, and so do notifications.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if matches!(window.label(), "main" | "picker" | "popup" | "box") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let WindowEvent::Focused(false) = event {
                if window.label() == "picker" && !picker_just_shown() {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            computers,
            api,
            api_owner,
            passcode_status, passcode_set, passcode_unlock, passcode_lock, passcode_clear,
            api_upload,
            design_image, design_save,
            pins,
            toggle_pin,
            settings,
            set_setting,
            link_agent, unlink_agent, desk_name, learn_names,
            host_state,
            show_main,
            toggle_picker,
            toggle_box,
            popup_layout,
            set_tray,
            quit,
        ])
        .run(tauri::generate_context!())
        .expect(concat!("error while running ", app_name!()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(words: &[&str]) -> Vec<String> {
        std::iter::once("cobra-desktop").chain(words.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn launches_read_as_the_desk_did() {
        assert_eq!(launch_request(&argv(&[])), Launch::Show(None));
        assert_eq!(launch_request(&argv(&["--hidden"])), Launch::Hidden);
        assert_eq!(launch_request(&argv(&["pick"])), Launch::Pick);
        assert_eq!(launch_request(&argv(&["ops"])), Launch::Show(Some("ops".into())));
        assert_eq!(launch_request(&argv(&["home"])), Launch::Show(Some("home".into())));
        assert_eq!(launch_request(&argv(&["box"])), Launch::Box);
        assert_eq!(launch_request(&argv(&["money"])), Launch::Show(Some("money".into())));
        // The Fleet page is gone: the word still brings the window up.
        assert_eq!(launch_request(&argv(&["fleet"])), Launch::Show(None));
        assert_eq!(launch_request(&argv(&["show", "agents"])), Launch::Show(Some("agents".into())));
        assert_eq!(launch_request(&argv(&["show"])), Launch::Show(None));
        // A word that is not a page still brings the window up, rather than doing nothing.
        assert_eq!(launch_request(&argv(&["whatever"])), Launch::Show(None));
        // A flag does not hide a page asked for with it.
        assert_eq!(launch_request(&argv(&["--hidden", "pick"])), Launch::Pick);
    }
}
