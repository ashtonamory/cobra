import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// The one piece of Cobra's desktop that lives in the shell: the mark
// and a count in the bar. Everything it shows comes from
// ~/.cache/cobra-desktop/state.json, which cobra-desktop rewrites (whole,
// then renamed into place; the FileView watch follows the path) whenever its
// fleet changes. It runs nothing and polls nothing itself; the timer below
// only re-reads the file, as a net under a shell whose watch does not survive
// the rename.
BarWidget {
  id: root
  moduleName: "cobra.desk"

  readonly property string home: Quickshell.env("HOME")
  readonly property string launcher: home + "/.local/bin/cobra-desktop"
  property int needsYou: 0
  property int working: 0
  property int alerts: 0
  property double updatedAt: 0
  property double now: Date.now()

  // The app writes on every poll (a few seconds); a minute of silence means it is not running.
  readonly property bool stale: updatedAt <= 0 || now - updatedAt > 60000

  // What follows the mark: the count waiting on you, "!" for an alert, "·"
  // when the app is not running, nothing when all is quiet.
  readonly property string mark: stale ? "·"
    : needsYou > 0 ? String(needsYou)
    : alerts > 0 ? "!"
    : ""

  implicitWidth: vertical ? barSize : label.implicitWidth
  implicitHeight: vertical ? label.implicitHeight : barSize

  function apply(text) {
    try {
      var s = JSON.parse(String(text || "{}"))
      root.needsYou = Number(s.needsYou) || 0
      root.working = Number(s.working) || 0
      root.alerts = Number(s.alerts) || 0
      root.updatedAt = Number(s.updatedAt) || 0
    } catch (e) {
      // a torn read; keep the last good values
    }
  }

  FileView {
    id: state
    path: root.home + "/.cache/cobra-desktop/state.json"
    watchChanges: true
    printErrors: false
    onLoaded: root.apply(text())
    onFileChanged: reload()
  }

  Timer { interval: 15000; running: true; repeat: true; onTriggered: { root.now = Date.now(); state.reload() } }

  // The shell routes bar clicks through its own WidgetButton (a mouse layer
  // over every slot handles drag-to-reorder and hands presses only to these),
  // so a plain MouseArea here would never see a click. The button's own label
  // stays hidden; the face below draws the mark and the text in its place,
  // the way the shell's BarIconButton hosts a glyph inside one.
  WidgetButton {
    id: label
    anchors.fill: parent
    bar: root.bar
    text: "J" + (root.mark !== "" ? " " + root.mark : "")
    labelVisible: false
    hasVisualContent: true
    fixedWidth: vertical ? -1 : face.implicitWidth + scaledHorizontalMargin * 2
    fixedHeight: vertical ? face.implicitHeight + scaledVerticalPadding * 2 : -1
    fontSize: Style.font.caption
    active: root.needsYou > 0 || root.alerts > 0
    dimmed: root.stale
    horizontalMargin: 7
    tooltipText: root.stale
      ? "Cobra's desktop is not running — click to start it"
      : (root.needsYou > 0 ? root.needsYou + " waiting on you · " : "")
        + root.working + " working" + (root.alerts > 0 ? " · " + root.alerts + " alerts" : "")
    onPressed: function (button) {
      if (!root.bar) return
      root.bar.run(root.launcher + (button === Qt.RightButton ? " pick" : " ops"))
    }

    // The bar's foreground, or its urgent colour while something needs you;
    // the button's opacity already dims the whole face when stale.
    readonly property color tint: active && useActiveColor ? activeColor : foreground

    Grid {
      id: face
      anchors.centerIn: parent
      columns: label.vertical ? 1 : 2
      spacing: Style.space(3)
      horizontalItemAlignment: Grid.AlignHCenter
      verticalItemAlignment: Grid.AlignVCenter

      Item {
        width: Style.bar.iconCanvas
        height: Style.bar.iconCanvas

        // The mark ships white (mark.svg, beside this file) and is tinted
        // here, as the tray tints symbolic icons: the image is kept as a
        // hidden layer the effect samples as a texture.
        Image {
          id: markImage
          anchors.fill: parent
          fillMode: Image.PreserveAspectFit
          sourceSize.width: Math.round(width * Screen.devicePixelRatio)
          sourceSize.height: Math.round(height * Screen.devicePixelRatio)
          source: Qt.resolvedUrl("mark.svg")
          visible: false
          layer.enabled: true
        }

        MultiEffect {
          anchors.fill: markImage
          source: markImage
          colorization: 1.0
          colorizationColor: label.tint
          Behavior on colorizationColor {
            enabled: !root.bar || root.bar.foregroundAnimationEnabled
            ColorAnimation { duration: 160 }
          }
        }
      }

      Text {
        visible: root.mark !== ""
        textFormat: Text.PlainText
        text: root.mark
        color: label.tint
        font.family: label.fontFamily
        font.pixelSize: label.fontSize
        renderType: Text.NativeRendering
        Behavior on color {
          enabled: !root.bar || root.bar.foregroundAnimationEnabled
          ColorAnimation { duration: 160 }
        }
      }
    }
  }
}
