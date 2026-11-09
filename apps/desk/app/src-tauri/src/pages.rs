//! Where a window may go. Cobra's own windows (main, picker, popup, box) show
//! only the app's bundled page; a terminal window shows only the agent's
//! terminal page on loopback. A web link that would load inside a window opens
//! in the person's browser instead, and anything else (a `data:` or
//! `javascript:` page, a file, another app's scheme) does not load. The email
//! previews' frames are `about:srcdoc`, which stays allowed. Phase 2 step 5
//! (docs/plans/phase-2-security.md).

use tauri::{plugin::TauriPlugin, Manager, Runtime, Url};

#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    /// Load it in the window.
    Stay,
    /// Open it in the person's browser and leave the window where it is.
    Browser,
    /// Do nothing.
    Block,
}

fn loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// The decision for one navigation of the window `label`. `dev` is the dev
/// server's address in a dev build (tauri.conf.json devUrl), None in a release.
pub fn decide(label: &str, url: &Url, dev: Option<&Url>) -> Nav {
    let scheme = url.scheme();
    // The bundled page: tauri://localhost (Linux, macOS), http(s)://tauri.localhost (Windows).
    if scheme == "tauri" || (matches!(scheme, "http" | "https") && url.host_str() == Some("tauri.localhost")) {
        return Nav::Stay;
    }
    // about:blank and about:srcdoc: an empty frame, or an email preview's.
    if scheme == "about" {
        return Nav::Stay;
    }
    if let Some(dev) = dev {
        if url.origin() == dev.origin() {
            return Nav::Stay;
        }
    }
    if label.starts_with("term-") && scheme == "http" && loopback(url) {
        return Nav::Stay;
    }
    if matches!(scheme, "http" | "https") {
        return Nav::Browser;
    }
    Nav::Block
}

pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("pages")
        .on_navigation(|webview, url| {
            let dev = if tauri::is_dev() { webview.config().build.dev_url.clone() } else { None };
            match decide(webview.label(), url, dev.as_ref()) {
                Nav::Stay => true,
                Nav::Browser => {
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    false
                }
                Nav::Block => false,
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn own_windows_stay_on_the_bundled_page() {
        for u in ["tauri://localhost/index.html?surface=main", "http://tauri.localhost/index.html", "https://tauri.localhost/", "about:srcdoc", "about:blank"] {
            assert_eq!(decide("main", &at(u), None), Nav::Stay, "{u}");
        }
    }

    #[test]
    fn web_links_go_to_the_browser() {
        assert_eq!(decide("main", &at("https://example.com/a"), None), Nav::Browser);
        assert_eq!(decide("popup", &at("http://example.com/"), None), Nav::Browser);
        // The agent's own API is not a page for the desk's windows either.
        assert_eq!(decide("main", &at("http://127.0.0.1:8787/fs/get?path=x"), None), Nav::Browser);
    }

    #[test]
    fn other_schemes_do_not_load() {
        for u in ["data:text/html,<script>alert(1)</script>", "javascript:alert(1)", "file:///etc/passwd", "asset://localhost/x"] {
            assert_eq!(decide("main", &at(u), None), Nav::Block, "{u}");
        }
    }

    #[test]
    fn a_terminal_window_stays_on_loopback() {
        assert_eq!(decide("term-s1", &at("http://127.0.0.1:8788/term/?ticket=t"), None), Nav::Stay);
        assert_eq!(decide("term-s1", &at("https://example.com/"), None), Nav::Browser);
        assert_eq!(decide("main", &at("http://127.0.0.1:8788/term/"), None), Nav::Browser);
    }

    #[test]
    fn the_dev_server_only_in_dev() {
        let dev = at("http://localhost:1420");
        assert_eq!(decide("main", &at("http://localhost:1420/index.html"), Some(&dev)), Nav::Stay);
        assert_eq!(decide("main", &at("http://localhost:1421/"), Some(&dev)), Nav::Browser);
        assert_eq!(decide("main", &at("http://localhost:1420/index.html"), None), Nav::Browser);
    }
}
