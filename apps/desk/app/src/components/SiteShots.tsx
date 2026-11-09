import { useEffect, useState } from "react";

import { siteShots, type SiteShot } from "../lib/site.ts";
import { useDesignUrl } from "./Chat.tsx";
import { Button } from "./ui.tsx";

/**
 * A website card's screenshots (agent site.ts, the site check): the top of the home page at desktop
 * and phone width, fetched from the computer as the thread's designs are; a
 * click opens the whole page to scroll. The phone's SiteShots.tsx draws the same.
 */
export function SiteShots({ machine, approval }: { machine: string; approval: unknown }) {
  const shots = siteShots(approval);
  const [open, setOpen] = useState<SiteShot | null>(null);
  if (!shots.length) return null;
  return (
    <div className="site-shots">
      {shots.map((shot) => <ShotTile key={shot.path} machine={machine} shot={shot} onOpen={() => setOpen(shot)} />)}
      {open ? <ShotPage machine={machine} shot={open} close={() => setOpen(null)} /> : null}
    </div>
  );
}

const wide = (shot: SiteShot) => shot.width >= 1000;

function ShotTile({ machine, shot, onOpen }: { machine: string; shot: SiteShot; onOpen: () => void }) {
  const [tries, setTries] = useState(0);
  const { url, failed } = useDesignUrl(machine, shot, tries);
  return (
    <button
      className={wide(shot) ? "site-shot desktop" : "site-shot phone"}
      title={failed ? `Could not load it: ${failed}. Click to try again.` : wide(shot) ? "The home page on a computer: click for the whole page" : "The home page on a phone: click for the whole page"}
      onClick={failed ? () => setTries((n) => n + 1) : url ? onOpen : undefined}
    >
      {url ? <img src={url} alt={wide(shot) ? "The home page on a computer" : "The home page on a phone"} /> : <span className="dim">{failed ? "Retry" : "…"}</span>}
    </button>
  );
}

function ShotPage({ machine, shot, close }: { machine: string; shot: SiteShot; close: () => void }) {
  const { url } = useDesignUrl(machine, shot, 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="design-overlay" onClick={close}>
      <div className="design-large site-page" onClick={(e) => e.stopPropagation()}>
        <div className="site-page-scroll">{url ? <img src={url} alt="The whole page" style={{ width: Math.min(shot.width, 720) }} /> : <span className="dim">Loading…</span>}</div>
        <div className="design-large-foot">
          <span className="dim ellipsis">{wide(shot) ? `On a computer (${shot.width} wide)` : `On a phone (${shot.width} wide)`}</span>
          <Button kind="flat" onClick={close}>Close</Button>
        </div>
      </div>
    </div>
  );
}
