import type { CSSProperties } from "react";

import { PREVIEW_SANDBOX, withPreviewPolicy } from "../lib/previewFrame.ts";

/**
 * The one place the desk draws generated HTML (lib/previewFrame.ts): a frame with an empty sandbox and the page's
 * own policy first. Never pass a key, ticket or token in `html`: the frame gets only the page.
 */
export function PreviewFrame({ html, title, className, style, tabIndex }: { html: string; title: string; className?: string; style?: CSSProperties; tabIndex?: number }) {
  return <iframe className={className} title={title} sandbox={PREVIEW_SANDBOX} referrerPolicy="no-referrer" srcDoc={withPreviewPolicy(html)} style={style} tabIndex={tabIndex} />;
}
