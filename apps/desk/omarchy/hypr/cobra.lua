-- Cobra's desktop (cobra-desktop) under Hyprland. Installed to
-- ~/.config/hypr/cobra.lua and loaded from ~/.config/hypr/hyprland.lua with
--   require("hypr.cobra")
-- by apps/desk/scripts/install-omarchy.sh. Omarchy's own defaults load first,
-- so what is here wins.
--
-- Every window of the app has the class cobra-desktop (its binary's name);
-- the small ones are told apart by title, which the app sets for this file
-- (src-tauri/src/lib.rs: PICKER_TITLE, POPUP_TITLE, BOX_TITLE). They begin with the app's
-- display name, Cobra (APP_NAME there).

local home = os.getenv("HOME")
local desk = home .. "/.local/bin/cobra-desktop"

-- The main window tiles with the others, opaque (it is a board, not a terminal).
o.window("^cobra-desktop$", { tag = "-default-opacity" })
o.window("^cobra-desktop$", { opacity = "1 1" })

-- The picker (SUPER+P): a floating panel in the middle of the screen, on
-- every workspace, that hides itself when it loses focus.
o.window({ class = "^cobra-desktop$", title = "^Cobra picker$" }, {
  float = true,
  center = true,
  pin = true,
  size = { 640, 460 },
})

-- The box (SUPER+SHIFT+J): the conversation with the lead in a floating panel
-- in the middle of the screen, on every workspace. It stays up when it loses
-- focus, so the answer can be watched; Esc or the key again hides it.
o.window({ class = "^cobra-desktop$", title = "^Cobra box$" }, {
  float = true,
  center = true,
  pin = true,
  size = { 560, 440 },
})

-- The needs-you column: top right, under the bar, never taking focus. The
-- app sets its height to what its cards need; Wayland lets it set nothing
-- else, so its place is this rule's.
o.window({ class = "^cobra-desktop$", title = "^Cobra needs you$" }, {
  float = true,
  pin = true,
  no_focus = true,
  move = { "(monitor_w-window_w-16)", "44" },
})

-- SUPER+P opens the picker. Omarchy binds SUPER+P to "Pseudo window" by
-- default, and a user bind stacks on a default rather than replacing it, so
-- the default is unbound first. To keep Pseudo, give it another key here:
--   o.bind("SUPER + ALT + P", "Pseudo window", hl.dsp.window.pseudo())
hl.unbind("SUPER + P")
o.bind("SUPER + P", "Cobra: find a session", desk .. " pick")

-- SUPER+SHIFT+J opens the box. Omarchy binds nothing there (SUPER+J is
-- its "Toggle window split", left alone).
o.bind("SUPER + SHIFT + J", "Cobra: message the lead", desk .. " box")
