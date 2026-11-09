"""Writes the Designer's email templates (emailDesign.ts), 600 wide, to Cobra's email design standard.

Run from the repository root:
    python3 apps/agent/scripts/email-designs.py apps/agent/designer/templates

Each is one frame, "Email", 600 wide, a column of auto-layout sections, in the
look of the standard's reference email (apps/agent/email-standard/reference.html):
a bold tight headline, calm grey words, one pill button, details on a soft
card with hairlines, a dark footer. Colours and fonts are tokens, so a brand
kit restyles one with one set_tokens: color.brand, color.accent, color.ink,
color.paper (the card), color.page (around it), color.body, color.muted,
color.line, color.soft, color.tint and color.night; font.heading, font.body.
Layer names carry the email's rules (emailDesign.ts EMAIL_DESIGN_RULES):
link:<address>, repeat:<list>, if:<field>, ifnot:<field>, semantic "button"
and "columns". Render one to look at it:
    tessel render apps/agent/designer/templates/email-receipt.tessel.json -o /tmp/receipt.svg
"""
import json, sys, pathlib

OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

TOKENS = {
    "colors": {
        "color.brand": "#0A84FF",
        "color.accent": "#F08C00",
        "color.ink": "#0B1220",
        "color.paper": "#FFFFFF",
        "color.page": "#EEF2F6",
        "color.body": "#2A3242",
        "color.muted": "#5B6474",
        "color.faint": "#8A93A3",
        "color.line": "#E3E7ED",
        "color.soft": "#F5F7FA",
        "color.tint": "#EAF5FD",
        "color.night": "#0B1220",
        "color.white": "#FFFFFF",
        "color.footer": "#C7CFDB",
    },
    "fonts": {"font.heading": "Inter", "font.body": "Inter"},
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

def flow(name, children, direction="column", gap=0, padding=(0, 0, 0, 0), align="start", justify="start",
         fill=None, width="fill", radius=None, stroke=None, semantic=None, fixed=None):
    """A frame with auto-layout: `width` is how it sizes in its parent (fill, hug or fixed with `fixed`)."""
    node = {"id": nid(name), "name": name, "kind": "frame", "x": 0, "y": 0,
            "width": fixed or 100, "height": 100, "clip": False,
            "fills": solid(fill) if fill else [],
            "layout_child": {"width": "fixed" if fixed else width, "height": "hug"},
            "layout": {"direction": direction, "gap": gap, "padding": list(padding), "justify": justify,
                       "align": align, "width": "fixed" if fixed else "hug", "height": "hug"},
            "children": children}
    if radius is not None:
        node["corner_radius"] = radius
    if stroke:
        node["strokes"] = solid(stroke)
        node["stroke_width"] = 1
        node["stroke_align"] = "inside"
    if semantic:
        node["semantic"] = semantic
    return node

def words(name, content, size, color="{color.body}", weight=400, line=None, width="fill", spacing=None,
          upper=False, align="left", font="{font.body}", semantic=None, underline=False):
    """A text: `line` in px (the reference sets each size's line in px)."""
    style = {"font_family": font, "font_weight": weight, "font_size": size,
             "line_height": {"px": line or round(size * 1.45)}}
    if spacing:
        style["letter_spacing"] = spacing
    if upper:
        style["text_transform"] = "upper"
    if underline:
        style["decoration"] = "underline"
    node = {"id": nid(name), "name": name, "kind": "text", "x": 0, "y": 0, "width": 100, "height": size,
            "content": content, "sizing": "auto_width" if width == "hug" else "auto_height",
            "fills": solid(color), "style": style, "layout_child": {"width": width, "height": "hug"}}
    if align != "left":
        node["align"] = align
    if semantic:
        node["semantic"] = semantic
    return node

def rule(name, color="{color.line}", height=1):
    return {"id": nid(name), "name": name, "kind": "rect", "x": 0, "y": 0, "width": 520, "height": height,
            "fills": solid(color), "layout_child": {"width": "fill", "height": "fixed"}}

def photo(name, w, h):
    return {"id": nid(name), "name": name, "kind": "rect", "x": 0, "y": 0, "width": w, "height": h,
            "fills": solid("#D9DEE5"), "corner_radius": 14, "layout_child": {"width": "fixed", "height": "fixed"}}

# --- the pieces --------------------------------------------------------------------------

def header(badge):
    """The business's name (or its logo, an image layer in its place) and a small pill saying what this is."""
    return flow("Header", [
        words("Logo", "Business name", 20, "{color.ink}", 700, 24, "hug", spacing=-0.3, font="{font.heading}"),
        flow("Badge", [words("BadgeText", badge, 11, "{color.brand}", 700, 13, "hug", spacing=1, upper=True)],
             direction="row", padding=(5, 10, 5, 10), fill="{color.tint}", radius=999, width="hug"),
    ], direction="row", padding=(28, 40, 0, 40), justify="space_between", align="center")

def hero(title, paragraphs, gap=16, top=34):
    kids = [words("Headline", title, 40, "{color.ink}", 800, 44, spacing=-1.2, font="{font.heading}", semantic="h1")]
    kids += [words(f"Words{i}", p, 16, "{color.body}", 400, 25) for i, p in enumerate(paragraphs, 1)]
    return flow("Hero", kids, gap=gap, padding=(top, 40, 8, 40))

def button(label, href, align="start", top=8):
    return flow("Action", [
        flow(f"link:{href}", [words("ButtonLabel", label, 16, "{color.white}", 700, 20, "hug")],
             direction="row", padding=(14, 28, 14, 28), fill="{color.brand}", radius=999, width="hug", semantic="button"),
    ], padding=(top, 40, 0, 40), align=align)

def row(name, label, value, strong=False, top_rule=True, rule_color="{color.line}", rule_height=1):
    kids = [rule(f"{name}Rule", rule_color, rule_height)] if top_rule else []
    kids.append(flow(f"{name}Row", [
        words(f"{name}Label", label, 14, "{color.ink}" if strong else "{color.muted}", 700 if strong else 400, 20),
        words(f"{name}Value", value, 14, "{color.ink}", 700 if strong else 600, 20, "hug", align="right"),
    ], direction="row", padding=(10, 0, 10, 0), gap=16, align="center"))
    return flow(name, kids)

def details(name, title, rows, extra=()):
    """A soft card of label and value rows between hairlines, like the reference's receipt."""
    kids = [words(f"{name}Title", title, 11, "{color.faint}", 700, 14, spacing=1.2, upper=True)]
    for i, (label, value) in enumerate(rows):
        kids.append(row(f"{name}{i + 1}", label, value, top_rule=i > 0))
    kids += list(extra)
    return flow(name, [flow(f"{name}Card", kids, gap=8, padding=(18, 20, 14, 20), fill="{color.soft}", radius=14)],
                padding=(26, 40, 0, 40))

def note(name, field, label, top=18):
    """A callout drawn only when its field has a value."""
    return flow(f"if:{field}", [flow(f"{name}Card", [
        words(f"{name}Label", label, 10, "{color.accent}", 700, 13, spacing=1.2, upper=True),
        words(f"{name}Words", "{{" + field + "}}", 14, "{color.body}", 400, 21),
    ], gap=4, padding=(12, 14, 12, 14), fill="#FFF4E5", radius=10)], padding=(top, 40, 0, 40))

def sign_off(lines):
    return flow("SignOff", [words(f"SignOff{i}", line, 15, "{color.body}", 400, 22) for i, line in enumerate(lines, 1)],
                gap=2, padding=(24, 40, 0, 40))

def footer(marketing):
    kids = [
        words("FooterName", "Business name", 16, "{color.white}", 700, 20, "hug", font="{font.heading}"),
        words("FooterLine", "One line about what the business does.", 13, "{color.footer}", 400, 18, "hug", align="center"),
        words("Address", "{{address}}", 11, "#7D8798", 400, 17, "hug", align="center"),
    ]
    if marketing:
        kids.append(words("link:{{unsubscribe_url}}", "Unsubscribe", 11, "#7D8798", 400, 17, "hug", underline=True))
    return flow("Footer", kids, gap=8, padding=(28, 40, 28, 40), align="center", fill="{color.night}")

def spacer(name, h=36):
    return flow(name, [], padding=(h, 0, 0, 0))

def email(name, title, description, sections):
    root = {"id": nid("Email"), "name": "Email", "kind": "frame", "x": 0, "y": 0, "width": 600, "height": 100,
            "clip": True, "fills": solid("{color.paper}"), "corner_radius": 0,
            "layout": {"direction": "column", "gap": 0, "padding": [0, 0, 0, 0], "justify": "start", "align": "start",
                       "width": "fixed", "height": "hug"},
            "children": sections}
    doc = {"format": {"name": "tessel", "version": 1},
           "meta": {"title": title, "description": description},
           "tokens": TOKENS,
           "pages": [{"id": "p_page000001", "name": "Email", "children": [root]}]}
    (OUT / f"{name}.tessel.json").write_text(json.dumps(doc, indent=1) + "\n")

COMMON = ("An email, 600 wide (never a post): the Email frame is the email's card and each child is a section, top to "
          "bottom. Restyle it in the brand with set_tokens (color.brand for the button and pill, color.ink, color.paper the "
          "card, color.page around it, color.night the footer; font.heading, font.body), put the business's name in Logo "
          "and FooterName (or replace Logo with the logo as an image layer named for its alt text) and its own words "
          "everywhere. {{field}} words are filled for each person; keep them. A layer named link:<address> links: rename "
          "it to the real address. Save it as a template with email_design_save, declaring its fields. ")

# --- the templates -----------------------------------------------------------------------

n = 0
email("email-receipt", "Receipt email",
      COMMON + "A payment receipt (transactional; the payment hook fills it). Fields: amount, invoice_number, paid_on, "
      "balance (default \"Nothing\"), and lines (a list, optional: the repeat:lines rows show what was paid for, "
      "each row's {{item}}, {{qty}} and {{amount}}; ifnot:lines draws when there are none). Subject \"Payment "
      "received, thank you\"; preheader \"We received {{amount}} for invoice {{invoice_number}}.\"",
      [header("Receipt"),
       hero("Thank you, {{first_name|there}}.", ["We received your payment of {{amount}}. This email is your receipt."]),
       details("Paid", "Payment", [("Invoice", "{{invoice_number}}"), ("Paid on", "{{paid_on}}")], extra=[
           flow("repeat:lines", [row("Line", "{{item}} × {{qty|1}}", "{{amount}}")]),
           row("Total", "Amount paid", "{{amount}}", strong=True, rule_color="{color.ink}", rule_height=2),
           row("Balance", "Still to pay", "{{balance}}"),
       ]),
       sign_off(["Questions about it? Just reply to this email."]),
       spacer("Gap"),
       footer(False)])

n = 0
email("email-invoice", "Invoice email",
      COMMON + "An invoice (transactional). Fields: invoice_number, amount_due, due_date, how_to_pay (default \"Reply "
      "to this email and we will tell you how to pay.\"), lines (a list: the repeat:lines rows, each {{item}}, {{qty}} "
      "and {{amount}}) and note (optional; if:note draws it). Rename the Pay button's layer to the payment link, or "
      "delete Action when there is none. Subject \"Invoice {{invoice_number}}\"; preheader \"{{amount_due}} due by "
      "{{due_date}}.\"",
      [header("Invoice"),
       hero("Invoice {{invoice_number}}", ["Hello {{first_name|there}}, here is your invoice. Thank you for your business."]),
       details("Items", "What it is for", [], extra=[
           flow("repeat:lines", [row("Line", "{{item}} × {{qty|1}}", "{{amount}}", top_rule=True)]),
           row("Due", "Amount due", "{{amount_due}}", strong=True, rule_color="{color.ink}", rule_height=2),
           row("By", "Due by", "{{due_date}}"),
       ]),
       note("Note", "note", "Note"),
       flow("HowToPay", [
           words("HowTitle", "How to pay", 18, "{color.ink}", 800, 24, spacing=-0.4, font="{font.heading}", semantic="h2"),
           words("HowWords", "{{how_to_pay}}", 15, "{color.body}", 400, 23),
       ], gap=6, padding=(26, 40, 0, 40)),
       button("Pay now", "https://example.com/pay"),
       spacer("Gap"),
       footer(False)])

n = 0
email("email-booking", "Booking confirmation email",
      COMMON + "A booking confirmation (transactional). Fields: what, date, time, place (default \"We will send the "
      "details before the day\"). Subject \"You're booked, {{first_name|there}}\"; preheader \"{{what}} on {{date}} "
      "at {{time}}.\"",
      [header("Booked"),
       hero("See you soon, {{first_name|there}}.", ["Your booking is confirmed. Here is everything you need."]),
       flow("When", [flow("WhenCard", [
           flow("DateTile", [
               words("Day", "{{date}}", 13, "{color.brand}", 700, 16, "hug", align="center", upper=True, spacing=0.6),
               words("Time", "{{time}}", 22, "{color.ink}", 800, 26, "hug", align="center", font="{font.heading}"),
           ], gap=4, padding=(14, 18, 14, 18), fill="{color.white}", radius=12, stroke="{color.line}", width="hug", align="center"),
           flow("WhatCopy", [
               words("What", "{{what}}", 18, "{color.ink}", 700, 23, font="{font.heading}"),
               words("Place", "{{place}}", 14, "{color.muted}", 400, 20),
           ], gap=4),
       ], direction="row", gap=18, padding=(16, 16, 16, 16), fill="{color.tint}", radius=14, align="center")],
           padding=(26, 40, 0, 40)),
       sign_off(["Need to change it? Reply to this email and we will sort it out."]),
       button("Add to calendar", "https://example.com/booking", top=22),
       spacer("Gap"),
       footer(False)])

n = 0
email("email-form-reply", "Form reply email",
      COMMON + "The reply to a website form (transactional; the form hook fills it). Fields: reply_within (default "
      "\"one working day\") and signed (default \"The team\"). Subject \"Thanks for getting in touch, "
      "{{first_name|there}}\"; preheader \"We have your message.\"",
      [header("Message received"),
       hero("Thanks, {{first_name|there}}.", ["We have your message and will reply within {{reply_within}}.",
                                              "While you wait, here is what happens next."]),
       flow("Steps", [
           flow(f"Step{i}", [
               flow(f"Step{i}Dot", [words(f"Step{i}Number", str(i), 12, "{color.brand}", 700, 26, "hug", align="center")],
                    direction="row", padding=(0, 9, 0, 9), fill="{color.tint}", radius=13, width="hug"),
               words(f"Step{i}Words", text, 14, "{color.body}", 400, 20),
           ], direction="row", gap=12, align="center", padding=(12, 14, 12, 14), stroke="{color.line}", radius=12)
           for i, text in enumerate(["We read your message, the same day.",
                                     "The right person writes back to you.",
                                     "If it helps, we set up a quick call."], 1)
       ], gap=8, padding=(22, 40, 0, 40)),
       sign_off(["Talk soon,", "{{signed}}"]),
       spacer("Gap"),
       footer(False)])

n = 0
email("email-outreach", "Outreach email",
      COMMON + "Outreach, one email a person (marketing with no topic, sent with email_batch): Body is each draft's "
      "own words, so keep {{body}} as it is and design around it: the header, an optional headline, the sign-off with "
      "the sender's name and role, one button if the outreach asks for a call. Fields: subject and body. Subject "
      "\"{{subject}}\". Marketing: keep Unsubscribe and {{address}} in the footer.",
      [header("Hello"),
       flow("Letter", [words("Body", "{{body}}", 16, "{color.body}", 400, 25)], padding=(30, 40, 0, 40)),
       button("Book a 15 minute call", "https://example.com/book", top=24),
       sign_off(["Best,", "Your name", "Your role, Business name"]),
       spacer("Gap", 40),
       footer(True)])

n = 0
email("email-newsletter", "Newsletter email",
      COMMON + "A newsletter (marketing with a topic, sent with email_campaign): a headline and lede, a Photo (a grey "
      "box: replace it with an image layer of the person's photo, named for its alt text, or delete it), a feature "
      "with a button, two stories side by side that stack on a phone (Stories: semantic columns), a closing line. "
      "No fields beyond the person's. Marketing: keep Unsubscribe and {{address}} in the footer.",
      [header("News"),
       hero("This month at Business name", ["Hi {{first_name|there}}, one short line on what this issue holds."]),
       flow("PhotoWrap", [photo("Photo", 520, 260)], padding=(18, 40, 0, 40)),
       flow("Feature", [
           words("FeatureEyebrow", "Feature", 11, "{color.brand}", 700, 14, spacing=1.2, upper=True),
           words("FeatureTitle", "The one thing worth reading", 28, "{color.ink}", 800, 32, spacing=-0.8, font="{font.heading}", semantic="h2"),
           words("FeatureWords", "Two or three sentences on it, in the business's own words.", 15, "{color.muted}", 400, 22),
       ], gap=8, padding=(30, 40, 0, 40)),
       button("Read more", "https://example.com/news"),
       flow("StoriesWrap", [flow("Stories", [
           flow(f"Story{i}", [
               words(f"Story{i}Title", title, 17, "{color.ink}", 700, 22, font="{font.heading}"),
               words(f"Story{i}Words", "A sentence or two about it.", 14, "{color.muted}", 400, 20),
               words(f"link:https://example.com/story-{i}", "Read it →", 14, "{color.brand}", 700, 20, "hug"),
           ], gap=6, padding=(16, 16, 16, 16), stroke="{color.line}", radius=14)
           for i, title in enumerate(["A second story", "A third story"], 1)
       ], direction="row", gap=14, semantic="columns")], padding=(34, 40, 0, 40)),
       flow("Closing", [words("ClosingWords", "Thanks for reading. Reply any time: a person reads every email.", 15, "{color.body}", 400, 22, align="center")],
            padding=(30, 40, 0, 40), align="center"),
       spacer("Gap", 40),
       footer(True)])
