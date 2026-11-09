// The brand kit (the Designer's brand/brand.json: four colours, two fonts) as
// the site's CSS. Text placed on the brand or accent colour takes whichever of
// ink, paper, black or white reads best, so an owner's light brand colour
// never gives a button text nobody can read.

/** Every family a brand kit may name (designer.ts BRAND_FONTS), as the woff2 files in fonts/ with their weights (and style, for an italic). */
export const FONTS = {
  Inter: { files: [["Inter.woff2", "100 900"]], fallback: "system-ui, sans-serif" },
  Montserrat: { files: [["Montserrat.woff2", "100 900"]], fallback: "system-ui, sans-serif" },
  Poppins: {
    files: [
      ["Poppins-Regular.woff2", "400"],
      ["Poppins-SemiBold.woff2", "600"],
      ["Poppins-Bold.woff2", "700"],
      ["Poppins-ExtraBold.woff2", "800"],
    ],
    fallback: "system-ui, sans-serif",
  },
  "Space Grotesk": { files: [["SpaceGrotesk.woff2", "300 700"]], fallback: "system-ui, sans-serif" },
  "Bebas Neue": { files: [["BebasNeue.woff2", "400"]], fallback: "Impact, sans-serif" },
  Oswald: { files: [["Oswald.woff2", "200 700"]], fallback: "system-ui, sans-serif" },
  "Playfair Display": { files: [["PlayfairDisplay.woff2", "400 900"]], fallback: "Georgia, serif" },
  Lora: { files: [["Lora.woff2", "400 700"]], fallback: "Georgia, serif" },
  "DM Serif Display": { files: [["DMSerifDisplay.woff2", "400"]], fallback: "Georgia, serif" },
  Caveat: { files: [["Caveat.woff2", "400 700"]], fallback: "cursive" },
  // The editorial faces: light display serifs with their italic, a quiet sans, mono labels.
  "Instrument Serif": {
    files: [
      ["InstrumentSerif-Regular.woff2", "400"],
      ["InstrumentSerif-Italic.woff2", "400", "italic"],
    ],
    fallback: "Georgia, serif",
  },
  "Bodoni Moda": {
    files: [
      ["BodoniModa.woff2", "400 900"],
      ["BodoniModa-Italic.woff2", "400 900", "italic"],
    ],
    fallback: "Georgia, serif",
    headingWeight: 400,
  },
  "Cormorant Garamond": {
    files: [
      ["CormorantGaramond.woff2", "300 700"],
      ["CormorantGaramond-Italic.woff2", "300 700", "italic"],
    ],
    fallback: "Georgia, serif",
    headingWeight: 400,
  },
  Fraunces: {
    files: [
      ["Fraunces.woff2", "100 900"],
      ["Fraunces-Italic.woff2", "100 900", "italic"],
    ],
    fallback: "Georgia, serif",
    headingWeight: 400,
  },
  Geist: { files: [["Geist.woff2", "100 900"]], fallback: "system-ui, sans-serif" },
  "Geist Mono": { files: [["GeistMono.woff2", "100 900"]], fallback: "ui-monospace, monospace" },
  Barlow: {
    files: [
      ["Barlow-Light.woff2", "300"],
      ["Barlow-Regular.woff2", "400"],
      ["Barlow-Medium.woff2", "500"],
    ],
    fallback: "system-ui, sans-serif",
  },
  "JetBrains Mono": { files: [["JetBrainsMono.woff2", "100 800"]], fallback: "ui-monospace, monospace" },
};

/** The look with no brand kit allowed yet. */
export const DEFAULT_BRAND = {
  colors: { brand: "#1F4E79", accent: "#C8642B", ink: "#1B1F24", paper: "#FFFFFF" },
  fonts: { heading: "Inter", body: "Inter" },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Of the candidates, the first that reaches 4.5:1 on `background`, else the one with the most contrast. */
export function readableOn(background, candidates) {
  const good = candidates.find((c) => contrast(c, background) >= 4.5);
  return good ?? [...candidates].sort((a, b) => contrast(b, background) - contrast(a, background))[0];
}

function mix(a, b, amountOfA) {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v * amountOfA + y[i] * (1 - amountOfA)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The theme a brand kit gives: the colours (checked, defaults where one is
 * missing or wrong), the fonts (shipped ones only), and the CSS.
 * Returns the font files the CSS names, for build.mjs to copy.
 */
export function themeOf(kit) {
  const colors = { ...DEFAULT_BRAND.colors };
  for (const key of Object.keys(colors)) if (HEX.test(kit?.colors?.[key] ?? "")) colors[key] = kit.colors[key].toUpperCase();
  const heading = FONTS[kit?.fonts?.heading] ? kit.fonts.heading : DEFAULT_BRAND.fonts.heading;
  const body = FONTS[kit?.fonts?.body] ? kit.fonts.body : DEFAULT_BRAND.fonts.body;
  // Ink must read on paper; a kit that fails gets the better of black and white.
  const ink = contrast(colors.ink, colors.paper) >= 4.5 ? colors.ink : readableOn(colors.paper, ["#111111", "#FFFFFF"]);
  const tokens = {
    brand: colors.brand,
    accent: colors.accent,
    ink,
    paper: colors.paper,
    "on-brand": readableOn(colors.brand, [colors.paper, ink, "#FFFFFF", "#000000"]),
    "on-accent": readableOn(colors.accent, [colors.paper, ink, "#FFFFFF", "#000000"]),
    link: contrast(colors.brand, colors.paper) >= 4.5 ? colors.brand : ink,
    muted: mix(ink, colors.paper, 0.72),
    tint: mix(colors.brand, colors.paper, 0.06),
    line: mix(ink, colors.paper, 0.14),
    "line-strong": mix(ink, colors.paper, 0.4),
  };
  // A display serif with one weight, or one set light by design (`headingWeight`), is never drawn bold.
  const upright = (family) => FONTS[family].files.filter(([, , style]) => !style);
  const singleWeight = (family) => upright(family).length === 1 && !upright(family)[0][1].includes(" ");
  const headingWeight = FONTS[heading].headingWeight ?? (singleWeight(heading) ? 400 : 700);
  const families = [...new Set([heading, body])];
  const faces = families.flatMap((family) =>
    FONTS[family].files.map(([file, weight, style]) => `@font-face {\n  font-family: "${family}";\n  src: url("/fonts/${file}") format("woff2");\n  font-weight: ${weight};\n${style ? `  font-style: ${style};\n` : ""}  font-display: swap;\n}`),
  );
  const css = [
    ...faces,
    `:root {\n${Object.entries(tokens)
      .map(([k, v]) => `  --${k}: ${v};`)
      .join("\n")}\n  --heading-font: "${heading}", ${FONTS[heading].fallback};\n  --body-font: "${body}", ${FONTS[body].fallback};\n  --heading-weight: ${headingWeight};\n}`,
  ].join("\n\n");
  return {
    theme: { headingFont: heading, bodyFont: body, headingWeight },
    tokens,
    css: `${css}\n`,
    fontFiles: families.flatMap((family) => FONTS[family].files.map(([file]) => file)),
  };
}
