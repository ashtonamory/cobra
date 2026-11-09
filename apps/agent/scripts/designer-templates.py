"""Writes the Designer's post templates (designer.ts), 1080 x 1350 (Instagram portrait).

Run from the repository root:
    python3 apps/agent/scripts/designer-templates.py apps/agent/designer/templates

Colours and fonts are tokens (color.brand, color.accent, color.ink, color.paper;
font.heading, font.body), so a brand kit restyles a template with one set_tokens.
Each layer has a plain name the Designer fills, and meta.description says what
goes in each; Tessel lists it and drops it from a copy. Render one to look at it:
    tessel render apps/agent/designer/templates/sale.tessel.json -o /tmp/sale.png --fonts apps/agent/designer/fonts
"""
import json, sys, pathlib

OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

TOKENS = {
    "colors": {
        "color.brand": "#1f3a5f",
        "color.accent": "#f2a541",
        "color.ink": "#14161a",
        "color.paper": "#f7f3ec",
    },
    "fonts": {"font.heading": "Montserrat", "font.body": "Inter"},
}

n = 0
def nid(name):
    global n
    n += 1
    # Tessel IDs are 10 Crockford base32 characters: no i, l, o or u.
    slug = "".join(c for c in name.lower() if c.isalnum()).translate(str.maketrans("ilou", "110v"))[:6].ljust(6, "x")
    return f"n_{slug}{n:04d}"

def solid(color):
    return [{"type": "solid", "color": color}]

def rect(name, x, y, w, h, color, radius=None, kind="rect", opacity=None):
    node = {"id": nid(name), "name": name, "kind": kind, "x": x, "y": y, "width": w, "height": h, "fills": solid(color)}
    if radius is not None:
        node["corner_radius"] = radius
    if opacity is not None:
        node["opacity"] = opacity
    return node

def text(name, content, x, y, w, h, size, color="{color.ink}", font="{font.heading}", weight=700,
         align="left", valign="top", line=None, spacing=None, transform=None, opacity=None):
    style = {"font_family": font, "font_weight": weight, "font_size": size}
    if line:
        style["line_height"] = {"percent": line}
    if spacing:
        style["letter_spacing"] = spacing
    if transform:
        style["text_transform"] = transform
    node = {"id": nid(name), "name": name, "kind": "text", "x": x, "y": y, "width": w, "height": h,
            "content": content, "sizing": "fixed", "fills": solid(color), "style": style}
    if align != "left":
        node["align"] = align
    if valign != "top":
        node["vertical_align"] = valign
    if opacity is not None:
        node["opacity"] = opacity
    return node

def write(name, title, description, background, children):
    global n
    doc = {
        "format": {"name": "tessel", "version": 1},
        "meta": {"title": title, "description": description},
        "tokens": TOKENS,
        "pages": [{"id": "p_page000001", "name": "Post", "children": [{
            "id": "n_frame00001", "name": "Design", "kind": "frame", "x": 0, "y": 0,
            "width": 1080, "height": 1350, "clip": True, "fills": solid(background), "children": children,
        }]}],
    }
    (OUT / f"{name}.tessel.json").write_text(json.dumps(doc, indent=2) + "\n")
    n = 0

LOGO = "Logo (the business name in text; with a logo in the brand kit, delete it and place the logo image in its box)"

write("sale", "Sale or offer",
      "An offer with one photo. Photo: set its fills to the photo (fit crop). Badge + BadgeText: the offer in 2 to 8 characters (30% OFF, 2 FOR 1). "
      "Headline: 2 to 5 words. Subhead: one line of detail (dates, what is included). CTA + CTAText: 2 or 3 words. " + LOGO + ".",
      "{color.paper}", [
          rect("Photo", 0, 0, 1080, 760, "{color.accent}"),
          rect("Badge", 760, 640, 240, 240, "{color.brand}", kind="ellipse"),
          text("BadgeText", "30%\nOFF", 760, 640, 240, 240, 64, "{color.paper}", weight=800, align="center", valign="middle", line=95),
          text("Headline", "Fall sale is on", 72, 860, 860, 200, 96, weight=800, line=102),
          text("Subhead", "Everything in store, this Saturday and Sunday only.", 72, 1070, 880, 110, 38, font="{font.body}", weight=400, line=130, opacity=0.8),
          rect("CTA", 72, 1206, 300, 84, "{color.brand}", radius=42),
          text("CTAText", "Shop now", 72, 1206, 300, 84, 32, "{color.paper}", font="{font.body}", weight=600, align="center", valign="middle"),
          text("Logo", "Happy Tails", 600, 1206, 408, 84, 34, "{color.brand}", weight=800, align="right", valign="middle"),
      ])

write("event", "Event",
      "A date, a title and the details, with a photo strip. DateDay + DateMonth: the day number and the short month (OCT). Headline: the event in 2 to 6 words. "
      "Details: time and place on one or two lines. CTA + CTAText: 2 or 3 words (RSVP, Book a spot). Photo: set its fills to a photo (fit crop), or delete it for text only. " + LOGO + ".",
      "{color.brand}", [
          rect("DateBlock", 72, 96, 220, 240, "{color.accent}", radius=28),
          text("DateDay", "14", 72, 112, 220, 150, 120, "{color.brand}", weight=800, align="center", valign="middle", line=100),
          text("DateMonth", "NOV", 72, 256, 220, 60, 40, "{color.brand}", font="{font.body}", weight=700, align="center", spacing=6),
          text("Logo", "Happy Tails", 330, 96, 678, 70, 34, "{color.paper}", weight=800, align="right", valign="middle"),
          text("Headline", "Puppy social & open day", 72, 390, 936, 260, 104, "{color.paper}", weight=800, line=100),
          text("Details", "Saturday 10am to 2pm\n12 Harbour Street, Brighton", 72, 670, 936, 130, 40, "{color.paper}", font="{font.body}", weight=400, line=135, opacity=0.85),
          rect("CTA", 72, 820, 320, 84, "{color.accent}", radius=42),
          text("CTAText", "Book a spot", 72, 820, 320, 84, 32, "{color.brand}", font="{font.body}", weight=700, align="center", valign="middle"),
          rect("Photo", 0, 960, 1080, 390, "{color.accent}", opacity=0.9),
      ])

write("quote", "Quote or review",
      "Words in the spotlight: a customer review, a testimonial or a saying. Quote: the words, at most about 25. Attribution: who said it (Sarah, regular since 2019). "
      "Stars: delete it when it is not a review. " + LOGO + ".",
      "{color.paper}", [
          text("QuoteMark", "“", 72, 60, 300, 300, 360, "{color.accent}", weight=800, line=100),
          text("Quote", "The kindest groomers in town. Biscuit comes home happy every single time.", 72, 330, 936, 560, 72, weight=700, line=115),
          text("Stars", "★★★★★", 72, 900, 600, 70, 52, "{color.accent}", font="{font.body}", weight=400, spacing=6),
          text("Attribution", "Sarah, a regular since 2019", 72, 980, 936, 60, 36, font="{font.body}", weight=500, opacity=0.75),
          rect("Band", 0, 1170, 1080, 180, "{color.brand}"),
          text("Logo", "Happy Tails", 72, 1170, 936, 180, 44, "{color.paper}", weight=800, valign="middle"),
      ])

write("new-product", "New product or service",
      "A full-bleed photo with a card at the foot. Photo: set its fills to the photo (fit crop); it fills the whole post, so choose one whose top two thirds carry it. "
      "Kicker: 1 to 3 words above the name (NEW, JUST IN). Headline: the product's name. Body: one or two lines on why it is good. " + LOGO + ".",
      "{color.ink}", [
          rect("Photo", 0, 0, 1080, 1350, "{color.accent}"),
          rect("Card", 48, 880, 984, 422, "{color.paper}", radius=36),
          text("Kicker", "New", 96, 920, 600, 50, 30, "{color.brand}", font="{font.body}", weight=700, spacing=4, transform="upper"),
          text("Headline", "The Winter Spa Day", 96, 972, 888, 120, 80, weight=800, line=102),
          text("Body", "A warm bath, a deep conditioning coat treatment and a cosy blow dry.", 96, 1094, 888, 110, 34, font="{font.body}", weight=400, line=130, opacity=0.8),
          text("Logo", "Happy Tails", 96, 1218, 888, 56, 30, "{color.brand}", weight=800),
      ])

write("announcement", "Announcement",
      "Bold words and no photo: news, hours, a reminder or a thank-you. Kicker: 1 to 3 words (NEWS, HEADS UP). Headline: at most about 8 words. "
      "Body: one or two short lines. Rule: a short accent bar; leave it. " + LOGO + ".",
      "{color.brand}", [
          text("Kicker", "Heads up", 72, 140, 936, 60, 34, "{color.accent}", font="{font.body}", weight=700, spacing=6, transform="upper"),
          rect("Rule", 72, 220, 140, 14, "{color.accent}", radius=7),
          text("Headline", "We have new opening hours", 72, 300, 936, 520, 124, "{color.paper}", weight=800, line=100),
          text("Body", "From 1 December: Monday to Saturday, 8am to 6pm.\nSee you soon!", 72, 860, 936, 200, 42, "{color.paper}", font="{font.body}", weight=400, line=135, opacity=0.85),
          text("Logo", "Happy Tails", 72, 1180, 936, 90, 40, "{color.paper}", weight=800, valign="middle"),
      ])
# --- The website starter -------------------
# Two top-level frames, Desktop (1440) and Phone (390), each a column of section
# frames with auto-layout, so a section grows with its words and the page with its
# sections. A concept restyles, reorders, deletes, duplicates or redraws them.
#
# The starter is the editorial standard: a light display serif set large and tight, a quiet light sans, small
# mono labels, wide whitespace, neutral grounds, the one brand colour only on rules,
# the italic word and links, hairline buttons, and real photos in full-bleed bands
# and 4:5 splits.

WEB_TOKENS = {
    "colors": {
        "color.brand": "#9a5b3c",   # the one accent: eyebrow rules, the italic word, links
        "color.ink": "#1d1d1f",
        "color.paper": "#fafaf7",
        "color.stone": "#f2efe7",
        "color.muted": "#57575a",
        "color.line": "#e3ddd0",
        "color.night": "#141414",
        "color.white": "#ffffff",
    },
    "fonts": {"font.heading": "Instrument Serif", "font.body": "Geist", "font.label": "Geist Mono"},
}

PHOTO = "#8c8478"   # a placeholder for a photo; never left in a concept
SCRIM = {"type": "linear_gradient", "start": [0.5, 0], "end": [0.5, 1], "stops": [
    {"offset": 0, "color": "#00000066"}, {"offset": 0.2, "color": "#00000000"},
    {"offset": 0.35, "color": "#00000014"}, {"offset": 1, "color": "#000000c2"}]}

def flow(name, children, direction="column", gap=0, padding=(0, 0, 0, 0), align="start", justify="start",
         fill=None, fills=None, width="fill", height="hug", fixed=None, semantic=None, stroke=None):
    """A frame with auto-layout. `fixed` is (w, h): either may be None for hug."""
    w, h = fixed or (None, None)
    node = {"id": nid(name), "name": name, "kind": "frame", "x": 0, "y": 0,
            "width": w or 100, "height": h or 100, "clip": h is not None,
            "fills": fills if fills is not None else (solid(fill) if fill else []),
            "layout_child": {"width": "fixed" if w and width != "fill" else width, "height": "fixed" if h else height},
            "layout": {"direction": direction, "gap": gap, "padding": list(padding), "justify": justify,
                       "align": align, "width": "fixed" if w else "hug", "height": "fixed" if h else "hug"},
            "children": children}
    if stroke:
        node["strokes"] = solid(stroke)
        node["stroke_width"] = 1
        node["stroke_align"] = "inside"
    if semantic:
        node["semantic"] = semantic
    return node

def words(name, content, size, color="{color.ink}", font="{font.body}", weight=300, line=150, width="fill",
          spacing=None, upper=False, italic=False, align="left", semantic=None):
    """A text that flows: width "fill", "hug" or a number of pixels (a measure, like 54ch)."""
    style = {"font_family": font, "font_weight": weight, "font_size": size, "line_height": {"percent": line}}
    if italic:
        style["italic"] = True
    if spacing:
        style["letter_spacing"] = spacing
    if upper:
        style["text_transform"] = "upper"
    fixed = isinstance(width, (int, float))
    node = {"id": nid(name), "name": name, "kind": "text", "x": 0, "y": 0, "width": width if fixed else 100,
            "height": size, "content": content, "sizing": "auto_width" if width == "hug" else "auto_height",
            "fills": solid(color), "style": style,
            "layout_child": {"width": "fixed" if fixed else width, "height": "hug"}}
    if align != "left":
        node["align"] = align
    if semantic:
        node["semantic"] = semantic
    return node

def box(name, w, h, fills, width="fixed", absolute=None):
    """A rectangle: a photo's place (Photo…), a hairline (Rule…) or a scrim."""
    node = {"id": nid(name), "name": name, "kind": "rect", "x": 0, "y": 0, "width": w, "height": h,
            "fills": fills, "layout_child": {"width": width, "height": "fixed"}}
    if absolute:
        node["x"], node["y"] = absolute
        node["layout_child"] = {"position": "absolute", "width": "fixed", "height": "fixed"}
    return node

def photo(name, w, h, width="fixed"):
    return box(name, w, h, solid(PHOTO), width)

def rule(name, w=32, color="{color.brand}", width="fixed"):
    return box(name, w, 1, solid(color), width)

def eyebrow(name, label, color="{color.muted}", rule_color="{color.brand}", align="start"):
    """Every section opens with one: a small mono label and a short rule under it."""
    return flow(name, [words(f"{name}Text", label, 12, color, "{font.label}", 400, 100, "hug", spacing=0.8, upper=True),
                       rule(f"{name}Rule", 32, rule_color)], gap=14, width="hug", align=align)

def button(name, label, ink="{color.ink}", fill=None):
    """A hairline rectangle: 11px, wide tracking, upper case. At most two a section."""
    return flow(name, [words(f"{name}Text", label, 11, "{color.white}" if fill else ink, "{font.body}", 500, 100, "hug",
                             spacing=3, upper=True)],
                direction="row", padding=(18, 40, 18, 40), width="hug", fill=fill, stroke=ink, semantic="button")

def heading(name, lines, size, color="{color.ink}", width="fill", semantic="h2", align="start", italic_color="{color.brand}"):
    """A display heading, one text a line; a line given as (before, word) sets `word` in italic, in the brand colour
    on a light ground (on a photo, the heading's own colour, so it reads)."""
    rows = []
    for i, line in enumerate(lines, 1):
        common = dict(font="{font.heading}", weight=400, line=102, spacing=round(-0.022 * size, 1))
        if isinstance(line, tuple):
            before, word = line
            rows.append(flow(f"{name}Line{i}", [
                words(f"{name}Line{i}Words", before, size, color, width="hug", **common),
                words(f"{name}Line{i}Italic", word, size, italic_color, width="hug", italic=True, **common),
            ], direction="row", gap=round(size * 0.2), align="baseline", width="hug"))
        else:
            rows.append(words(f"{name}Line{i}", line, size, color, width="hug", **common))
    return flow(name, rows, width=width, align=align, semantic=semantic)

def site_page(name, w, phone):
    side = 24 if phone else 72                     # clamp(24px, 5vw, 88px)
    inner = w - 2 * side
    gap_y = 104 if phone else 144                  # clamp(100px, 14vh, 180px)
    display, head, lede, body = (48, 40, 18, 16) if phone else (112, 76, 22, 17)
    measure = inner if phone else 520              # body at about 54ch
    pad = (gap_y, side, gap_y, side)
    on_photo = "#ffffffcc"

    nav = flow("Nav", [
        words("Logo", "Happy Tails", 24 if phone else 26, "{color.white}", "{font.heading}", 400, 100, "hug", spacing=-0.3),
        *([] if phone else [flow("NavLinks", [
            words(f"NavLink{i}", label, 11, "{color.white}", "{font.body}", 500, 100, "hug", spacing=2.4, upper=True)
            for i, label in enumerate(["Grooming", "About", "Visit"], 1)], direction="row", gap=44, width="hug")]),
        words("NavMenu", "Menu", 11, "{color.white}", "{font.label}", 400, 100, "hug", spacing=1.2, upper=True)
        if phone else button("NavCTA", "Book", "{color.white}"),
    ], direction="row", padding=(22 if phone else 28, side, 0, side), align="center", justify="space_between",
        fixed=(w, None), semantic="nav")
    nav["layout_child"] = {"position": "absolute", "width": "fixed", "height": "hug"}

    hero_h = 760 if phone else 900                 # 100vh; at least 85vh on a phone
    hero = flow("Hero", [
        box("PhotoHero", w, hero_h, solid(PHOTO), absolute=(0, 0)),
        box("Scrim", w, hero_h, [SCRIM], absolute=(0, 0)),
        nav,
        flow("HeroCopy", [
            eyebrow("HeroEyebrow", "Dog grooming · Leeds", on_photo, "{color.white}"),
            heading("Headline", ["Happy dogs,", ("every", "visit.")], display, "{color.white}", semantic="h1",
                    italic_color="{color.white}"),
            words("HeroLede", "Calm, careful grooming by people who know dogs. One dog at a time, never a queue.",
                  lede, on_photo, line=145, width=inner if phone else 560),
            flow("HeroButtons", [button("HeroCTA", "Book a groom", "{color.white}"),
                                 *([] if phone else [button("HeroMore", "Our grooms", "{color.white}")])],
                 direction="row", gap=16, width="hug"),
        ], gap=28 if phone else 32, width="fill"),
    ], justify="end", padding=(0, side, 64 if phone else 104, side), fixed=(None, hero_h), semantic="section")

    copy = lambda prefix, label, lines, text, cta: [
        eyebrow(f"{prefix}Eyebrow", label),
        heading(f"{prefix}Heading", lines, head, width="hug"),
        words(f"{prefix}Body", text, body, "{color.muted}", line=180, width=measure),
        flow(f"{prefix}Link", [
            words(f"{prefix}LinkText", cta, 11, "{color.ink}", "{font.body}", 500, 100, "hug", spacing=3, upper=True),
            box(f"{prefix}LinkRule", 100, 1, solid("{color.ink}"), width="fill"),
        ], gap=10, width="hug"),
    ]
    split_w = inner if phone else round((inner - 96) * 1.05 / 2.05)
    intro = flow("Intro", [
        photo("PhotoIntro", split_w, round(split_w * 5 / 4)),
        flow("IntroCopy", copy("Intro", "The studio", ["A quiet room,", ("a", "patient hand.")],
             "We groom one dog at a time in a calm, sunny room off Harbour Street. No cages, no rush, and no "
             "dryers roaring in the next room: just a bath, a cut and a lot of praise.", "About us"),
             gap=32, width="fill"),
    ], direction="column" if phone else "row", gap=48 if phone else 96, align="start" if phone else "center",
        padding=pad, fill="{color.paper}", semantic="section")

    band_h = 640 if phone else 780                 # clamp(520px, 86vh, 900px)
    band = flow("Band", [
        box("PhotoBand", w, band_h, solid(PHOTO), absolute=(0, 0)),
        box("BandScrim", w, band_h, [SCRIM], absolute=(0, 0)),
        flow("BandCopy", [
            eyebrow("BandEyebrow", "Puppies", on_photo, "{color.white}"),
            heading("BandHeading", ["Their first groom,", "gently."], head, "{color.white}", width="hug"),
            words("BandBody", "Short first visits, lots of breaks and a treat at every step, so grooming is "
                  "never something to fear.", body, on_photo, line=180, width=measure),
            button("BandCTA", "Puppy visits", "{color.white}"),
        ], gap=28, width="fill"),
    ], justify="end", padding=(0, side, 64 if phone else 104, side), fixed=(None, band_h), semantic="section")

    items = [("01", "Full groom", "Bath, cut, nails and ears, the way your dog likes it.", "From £45"),
             ("02", "Bath and tidy", "A wash, a brush out and a trim between full grooms.", "From £30"),
             ("03", "Puppy visit", "Short, gentle first visits for dogs under six months.", "£20"),
             ("04", "Nails and ears", "A ten minute visit, no booking needed on weekdays.", "£10")]
    def row(i, num, title, text, price):
        if phone:
            content = flow(f"Item{i}Words", [
                words(f"Item{i}Title", title, 28, font="{font.heading}", weight=400, line=110, width="fill"),
                words(f"Item{i}Body", text, 15, "{color.muted}", line=165),
                words(f"Item{i}Price", price, 11, "{color.ink}", "{font.label}", 400, 100, "hug", spacing=1, upper=True),
            ], gap=10, width="fill")
            cells = [words(f"Item{i}Number", num, 22, "{color.brand}", "{font.heading}", 400, 120, 44), content]
        else:
            cells = [
                words(f"Item{i}Number", num, 26, "{color.brand}", "{font.heading}", 400, 120, 140),
                words(f"Item{i}Title", title, 36, font="{font.heading}", weight=400, line=110, width=400, spacing=-0.6),
                words(f"Item{i}Body", text, body, "{color.muted}", line=170, width="fill"),
                words(f"Item{i}Price", price, 12, "{color.ink}", "{font.label}", 400, 100, 140, spacing=1, upper=True, align="right"),
            ]
        return flow(f"Item{i}", [rule(f"Item{i}Rule", inner, "{color.line}", width="fill"),
                                 flow(f"Item{i}Row", cells, direction="row", gap=0 if phone else 24,
                                      padding=(28 if phone else 36, 0, 28 if phone else 36, 0),
                                      align="start" if phone else "center", width="fill")], width="fill")
    index = flow("Services", [
        flow("ServicesIntro", [
            eyebrow("ServicesEyebrow", "Grooming"),
            heading("ServicesHeading", [("What we", "do.")], head, width="hug"),
        ], gap=32, width="fill"),
        flow("ServicesList", [row(i, *item) for i, item in enumerate(items, 1)]
             + [rule("ServicesEndRule", inner, "{color.line}", width="fill")], width="fill"),
    ], gap=56 if phone else 80, padding=pad, fill="{color.paper}", semantic="section")

    facts = [("2014", "Grooming in Leeds since"), ("1", "Dog at a time"), ("90", "Minutes, a full groom")]
    fact_cells = [flow(f"Fact{i}", [
        rule(f"Fact{i}Rule", 100, "{color.ink}", width="fill"),
        words(f"Fact{i}Number", num, 44 if phone else 56, font="{font.heading}", weight=400, line=100, spacing=-1),
        words(f"Fact{i}Label", label, 11, "{color.muted}", "{font.label}", 400, 140, spacing=0.8, upper=True),
    ], gap=18, width="fill") for i, (num, label) in enumerate(facts, 1)]
    fact_strip = flow("Facts", [
        eyebrow("FactsEyebrow", "In numbers"),
        flow("FactRow", fact_cells, direction="column" if phone else "row", gap=40 if phone else 48, width="fill"),
    ], gap=48 if phone else 64, padding=pad, fill="{color.stone}", semantic="section")

    field = lambda n, label: flow(n, [
        words(f"{n}Label", label, 11, "{color.muted}", "{font.label}", 400, 100, "hug", spacing=0.8, upper=True),
        box(f"{n}Line", 100, 1, solid("{color.ink}"), width="fill"),
    ], gap=28, width="fill")
    invitation = flow("Contact", [
        eyebrow("ContactEyebrow", "Book a groom", align="center"),
        heading("ContactHeading", [("Come say", "hello.")], head, width="hug", align="center"),
        words("ContactBody", "Leave your name and email and we will write back within a day with a time that suits.",
              lede, "{color.muted}", line=150, width=inner if phone else 560, align="center"),
        flow("Form", [field("NameField", "Name"), field("EmailField", "Email"),
                      button("Send", "Send", fill="{color.ink}")],
             gap=32, padding=(24, 0, 0, 0), width="fill" if phone else "fixed", fixed=None if phone else (560, None),
             align="center"),
    ], gap=36, padding=pad, align="center", fill="{color.paper}", semantic="section")

    # Four columns, 1.4fr 1fr 1fr 1fr; one column on a phone.
    unit = (inner - 3 * 48) / 4.4
    col = lambda n, title, lines, wide=False: flow(n, [
        words(f"{n}Title", title, 11, "#ffffff73", "{font.label}", 400, 100, "hug", spacing=1.2, upper=True),
        words(f"{n}Lines", lines, 15, "#ffffffcc", line=175),
    ], gap=18, width="fill" if phone else "fixed", fixed=None if phone else (round(unit * (1.4 if wide else 1)), None))
    cols = [col("FindUs", "Find us", "12 Harbour Street\nLeeds LS1 4AB", True),
            col("ReachUs", "Reach us", "hello@happytails.example\n0113 000 0000"),
            col("Hours", "Hours", "Tue to Sat · 9 to 5\nSun and Mon · closed"),
            col("Visit", "Visit", "Grooming\nPuppies\nAbout")]
    footer = flow("Footer", [
        words("Wordmark", "Happy Tails", 64 if phone else 168, "{color.white}", "{font.heading}", 400, 100,
              spacing=-1.4 if phone else -4),
        box("FooterRule", 100, 1, solid("#ffffff24"), width="fill"),
        flow("FooterColumns", cols, direction="column" if phone else "row", gap=36 if phone else 48, width="fill"),
        box("FooterRuleEnd", 100, 1, solid("#ffffff24"), width="fill"),
        flow("FooterBar", [
            words("FooterSmall", "© 2026 Happy Tails · Leeds", 10, "#ffffff73", "{font.label}", 400, 100, "hug", spacing=1.6, upper=True),
            *([] if phone else [words("FooterNote", "Grooming by appointment", 10, "#ffffff73", "{font.label}", 400, 100, "hug", spacing=1.6, upper=True)]),
        ], direction="row", justify="space_between", width="fill"),
    ], gap=48 if phone else 64, padding=(96 if phone else 128, side, 40, side), fill="{color.night}", semantic="footer")

    frame = flow(name, [hero, intro, band, index, fact_strip, invitation, footer], fill="{color.paper}",
                 fixed=(w, None), width="fixed")
    frame.pop("layout_child")
    frame["clip"] = True
    return frame

SECTIONS = ["Hero", "Intro", "Band", "Services", "Facts", "Contact", "Footer"]

def write_site(name, title, description):
    global n
    desktop = site_page("Desktop", 1440, False)
    phone = site_page("Phone", 390, True)
    phone["x"] = 1540
    doc = {
        "format": {"name": "tessel", "version": 1},
        "meta": {"title": title, "description": description},
        "tokens": WEB_TOKENS,
        "pages": [{"id": "p_page000001", "name": "Website", "children": [desktop, phone]}],
    }
    (OUT / f"{name}.tessel.json").write_text(json.dumps(doc, indent=2) + "\n")
    n = 0

write_site("website", "Website concept",
           "A home page at two widths, for a website concept (never a post): Desktop, 1440 wide, and Phone, 390 wide, beside it. "
           "It is the editorial standard: a light display serif set large and tight (font.heading, weight 400, never bold), "
           "a quiet light sans for words (font.body, 300), small mono labels (font.label), neutral grounds (paper, stone, night) "
           "and the one brand colour only on the short rules, the italic word and links. "
           "Sections, top to bottom: Hero (a full-bleed photo with a scrim, the Nav over it, the words bottom left), "
           "Intro (an eyebrow and a split, photo 4:5 beside the words), Band (a full-bleed photo with words bottom left), "
           "Services (an index list: numbered rows between hairlines), Facts (numbers with mono labels), "
           "Contact (a centred closing invitation with the Form) and Footer (dark, a big wordmark, four columns). "
           "Every section is a frame whose children flow top to bottom, so it grows with its words and the page grows with its sections. "
           "This is a starting point, not the look: restyle, reorder, delete, duplicate or redraw sections until the concept has a "
           "character of its own, and change both frames together so Phone is the same site laid out for a phone "
           "(splits stack with the photo first). "
           "The rectangles named Photo stand for pictures: fill them with the person's photos or art (import_image, fit crop; "
           "pixel art with scale); with no photos, delete them and their scrims and let the words carry the page. "
           "A heading line in two texts sets its second word in italic in the brand colour: keep at most one per heading. "
           "Form stands for a form: Cobra's contact or waitlist form, or one of the site's own with the fields the business needs, "
           "drawn in the concept's style (hairline fields, one button). Every word is an example: use the person's.")

print("wrote", sorted(p.name for p in OUT.iterdir()))
