import { createHash } from "node:crypto";

/**
 * The terminal page served to the app's WebView.
 *
 * Served from the gateway rather than inlined into the app so the WebSocket is
 * same-origin, xterm.js never comes from a CDN, and the terminal keeps working
 * without internet.
 */
export const TERMINAL_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<link rel="stylesheet" href="./xterm.css">
<style>
  html, body {
    margin: 0; padding: 0; height: 100%; width: 100%;
    background: #0F1216; overflow: hidden;
    -webkit-text-size-adjust: 100%;
  }
  #term { height: 100%; width: 100%; }
  /* xterm owns its own scroller; let it accept touch momentum. */
  .xterm-viewport {
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  /* The cursor is hard to find on a small screen when it is a thin bar. */
  .xterm-cursor-block { outline: 1px solid #E4A24A; }
  #status {
    position: fixed; left: 0; right: 0; bottom: 0;
    font: 11px ui-monospace, Menlo, monospace;
    color: #E0685F; background: #1A1014;
    padding: 6px 10px; display: none;
  }
</style>
</head>
<body>
<div id="term"></div>
<div id="status"></div>
<script src="./xterm.js"></script>
<script src="./addon-fit.js"></script>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var statusEl = document.getElementById("status");

  function fail(message) {
    statusEl.textContent = message;
    statusEl.style.color = "#E0685F";
    statusEl.style.display = "block";
  }

  function notice(message) {
    statusEl.textContent = message;
    statusEl.style.color = "#E4A24A";
    statusEl.style.display = "block";
  }

  var term = new Terminal({
    // 12px is the smallest that stays readable on a phone while giving enough
    // columns for a TUI to lay out sensibly.
    fontSize: parseInt(params.get("fontSize") || "12", 10),
    fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace',
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: "block",
    scrollback: 5000,
    // Phones have no physical scrollbar and the WebView's own momentum
    // scrolling fights xterm's, so let xterm own it entirely.
    scrollSensitivity: 2,
    theme: {
      background: "#0F1216", foreground: "#E6EAEF", cursor: "#E4A24A",
      selectionBackground: "#2A3039",
      black: "#0F1216", red: "#E0685F", green: "#5FB98A", yellow: "#E4A24A",
      blue: "#6AA9E0", magenta: "#C98AD6", cyan: "#5FB3B3", white: "#E6EAEF",
      brightBlack: "#59626D", brightRed: "#F08078", brightGreen: "#79D3A4",
      brightYellow: "#F5BC6A", brightBlue: "#84C0F5", brightMagenta: "#DFA4EA",
      brightCyan: "#7FCCCC", brightWhite: "#FFFFFF"
    }
  });

  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  fit.fit();

  var ticket = params.get("ticket");
  if (!ticket) { fail("No ticket supplied"); return; }

  /**
   * Reconnect.
   *
   * A socket can drop (the computer slept, the page was put aside). tmux
   * means nothing is actually lost — the session keeps
   * running on the far side — so the only thing standing between a blip and a
   * lost coding session was that this page used to give up and ask to be
   * reopened. The gateway keeps us supplied with a ticket to reattach with.
   */
  var socket = null;
  var connected = false;
  var attempts = 0;

  function connect() {
    var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host + "/term/attach?ticket=" + encodeURIComponent(ticket) +
      "&cols=" + term.cols + "&rows=" + term.rows;

    var ws = new WebSocket(wsUrl);
    socket = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      var returning = connected;
      connected = true;
      attempts = 0;
      statusEl.style.display = "none";
      if (returning) {
        term.write("\\r\\n\\x1b[2m[reconnected]\\x1b[0m\\r\\n");
      }
      post({ type: "connected", cols: term.cols, rows: term.rows });
    };

    ws.onmessage = function (event) {
      if (typeof event.data === "string") { term.write(event.data); return; }
      // Binary is a control message — pty output is always text.
      try {
        var message = JSON.parse(new TextDecoder().decode(new Uint8Array(event.data)));
        if (message.t === "reconnect-ticket" && message.ticket) ticket = message.ticket;
      } catch (e) { /* ignore anything we do not understand */ }
    };

    ws.onerror = function () { post({ type: "error" }); };

    ws.onclose = function () {
      // A close from a socket we have already replaced must not drive the
      // backoff, or one slow teardown burns several attempts at once.
      if (socket !== ws) return;
      post({ type: "closed" });
      if (!connected) {
        fail("Could not connect. Ticket expired or already used.");
        return;
      }
      retry();
    };
  }

  function retry() {
    attempts++;
    if (attempts > 8) {
      fail("Lost connection — the tmux session is still running. Go back and reopen.");
      return;
    }
    notice("reconnecting…");
    setTimeout(connect, Math.min(500 * Math.pow(2, attempts - 1), 8000));
  }

  connect();

  term.onData(function (data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: "input", d: data }));
    }
  });

  function resize() {
    try { fit.fit(); } catch (e) { return; }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    }
    post({ type: "size", cols: term.cols, rows: term.rows });
  }

  // The visual viewport shrinks when the software keyboard appears; without
  // this the bottom rows sit underneath it and the prompt is invisible.
  window.addEventListener("resize", resize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", resize);
  }

  function post(message) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  /**
   * Scrolling.
   *
   * Inside tmux the outer terminal's scrollback is useless: tmux redraws the
   * visible region and keeps history in its own copy-mode buffer, so xterm's
   * viewport only ever holds the last repaint. Scrolling has to reach tmux.
   *
   * The previous attempt synthesised DOM wheel events and hoped xterm's mouse
   * encoder would pick them up. It did not — too many assumptions about which
   * element listens and whether a synthetic event survives the path. This
   * drives the two cases explicitly instead:
   *
   *   mouse tracking on  → emit the wheel sequence ourselves, tmux scrolls
   *                        its history and enters copy-mode on its own
   *   mouse tracking off → term.scrollLines(), xterm's own buffer
   */
  function mouseEncoding() {
    // Not public API, so read it defensively. tmux requests SGR (1006) in every
    // version that matters, which is also the safe default.
    try {
      return term._core.coreMouseService.activeEncoding || "SGR";
    } catch (e) {
      return "SGR";
    }
  }

  function wheelSequence(up) {
    // Wheel is button 64 (up) / 65 (down) in every X11 mouse encoding.
    var button = up ? 64 : 65;

    // Aim at the middle of the terminal, not the top-left corner.
    //
    // tmux routes a mouse event to whatever sits under it, and row 1 is not
    // necessarily a pane: this tmux.conf sets \`status-position top\`, so row 1
    // is the status bar and a wheel there scrolls nothing at all. The centre is
    // inside a pane under any status placement or split layout.
    var col = Math.max(1, Math.floor(term.cols / 2));
    var row = Math.max(1, Math.floor(term.rows / 2));

    if (mouseEncoding() === "SGR") {
      return "\x1b[<" + button + ";" + col + ";" + row + "M";
    }
    // X10/VT200: byte-encoded, offset by 32, capped at what a byte holds.
    return "\x1b[M" + String.fromCharCode(
      32 + button,
      32 + Math.min(col, 223),
      32 + Math.min(row, 223)
    );
  }

  function scrollBy(lines) {
    if (lines === 0) return;
    var tracking = term.modes && term.modes.mouseTrackingMode;

    if (tracking && tracking !== "none" && socket && socket.readyState === WebSocket.OPEN) {
      var seq = "";
      var n = Math.min(Math.abs(lines), 40);
      for (var i = 0; i < n; i++) seq += wheelSequence(lines < 0);
      socket.send(JSON.stringify({ t: "input", d: seq }));
    } else {
      term.scrollLines(lines);
    }
  }

  var touchY = null;
  var LINE_HEIGHT = 18;
  var screen = document.getElementById("term");

  screen.addEventListener("touchstart", function (event) {
    touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
  }, { passive: true });

  screen.addEventListener("touchmove", function (event) {
    if (touchY === null || event.touches.length !== 1) return;
    var y = event.touches[0].clientY;
    var dy = touchY - y;
    if (Math.abs(dy) < LINE_HEIGHT) return;
    touchY = y;
    // Dragging the content down should reveal older output, as on any phone.
    scrollBy(Math.trunc(dy / LINE_HEIGHT));
  }, { passive: true });

  screen.addEventListener("touchend", function () { touchY = null; }, { passive: true });

  window.cpScroll = function (pages) {
    scrollBy(Math.round(pages * term.rows * 0.9));
  };

  // Lets the app confirm what the terminal thinks is going on, instead of
  // guessing from the outside when scrolling misbehaves.
  window.cpDiag = function () {
    var diag = {
      type: "diag",
      tracking: (term.modes && term.modes.mouseTrackingMode) || "unknown",
      encoding: mouseEncoding(),
      rows: term.rows,
      cols: term.cols,
    };
    post(diag);
    return diag;
  };

  // Input injected from the native accessory key bar.
  window.cpSend = function (data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: "input", d: data }));
    }
    term.focus();
  };
  window.cpFocus = function () { term.focus(); };
  window.cpFit = resize;

  term.focus();
})();
</script>
</body>
</html>
`;

/** The page's one inline script, by its hash, so the policy allows it and no other. */
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(TERMINAL_PAGE)?.[1] ?? "";
const INLINE_HASH = `'sha256-${createHash("sha256").update(INLINE_SCRIPT, "utf8").digest("base64")}'`;

/** A Host header as it may appear in a policy: loopback name or address and a port, or nothing. */
function socketOrigin(host: string | undefined): string {
  return host && /^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(host) ? ` ws://${host}` : "";
}

/**
 * The terminal page's headers (phase 2 step 5): its scripts are xterm's files from here and the one inline script by
 * hash; it talks only to its own socket; it can be framed by nothing and loads nothing else. xterm writes <style>
 * elements, hence style-src 'unsafe-inline'.
 */
export function terminalPageHeaders(host: string | undefined): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'self' ${INLINE_HASH}`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      `connect-src 'self'${socketOrigin(host)}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}
