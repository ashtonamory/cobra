/**
 * No link moves a desk window. The chat's own handlers (CobraChat, Agents) copy `copy:` links and open web links;
 * this catches any click they did not take: a web link (http or https) opens in the person's browser, and anything
 * else (javascript:, data:, file:, a relative path) does nothing. pages.rs refuses the same navigations on the Rust
 * side. Phase 2 step 5 (docs/plans/phase-2-security.md).
 */
export const WEB_LINK = /^https?:\/\//i;

export function installLinkGuard(target: Pick<Window, "addEventListener" | "removeEventListener">, open: (url: string) => unknown): () => void {
  const onClick = (e: Event) => {
    if (e.defaultPrevented) return; // a page's own handler took it
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (WEB_LINK.test(href)) void Promise.resolve(open(href)).catch(() => {});
  };
  target.addEventListener("click", onClick);
  target.addEventListener("auxclick", onClick);
  return () => {
    target.removeEventListener("click", onClick);
    target.removeEventListener("auxclick", onClick);
  };
}
