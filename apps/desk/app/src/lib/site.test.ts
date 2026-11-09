import { describe, expect, it } from "vitest";
import { siteDomains, sitePreview, sitePreviewLabel, siteShots, siteSource } from "./site.ts";

describe("sitePreview", () => {
  it("opens only a workers.dev https address from a site card", () => {
    expect(sitePreview({ site: { previewUrl: "https://ab12cd34-happy-tails.acme.workers.dev/" } })).toBe("https://ab12cd34-happy-tails.acme.workers.dev/");
    expect(sitePreview({ site: { previewUrl: "http://ab12cd34-happy-tails.acme.workers.dev/" } })).toBeNull();
    expect(sitePreview({ site: { previewUrl: "https://evil.example/" } })).toBeNull();
    expect(sitePreview({ site: { previewUrl: "not a url" } })).toBeNull();
    expect(sitePreview({ title: "Merge?" })).toBeNull();
    expect(sitePreview(null)).toBeNull();
  });
});

describe("siteSource", () => {
  it("says where Allow saves the source: the recorded repo, a new one, or nothing", () => {
    expect(siteSource({ site: { github: { repo: "me/happy-tails-website" } } })).toBe("Saves the source to GitHub: me/happy-tails-website (private)");
    expect(siteSource({ site: { github: { repo: "me/happy-tails-website", newRepo: true } } })).toBe("Saves the source to GitHub: me/happy-tails-website (new private repo)");
    expect(siteSource({ site: { github: { repo: "a b/c" } } })).toBeNull();
    expect(siteSource({ site: { previewUrl: "https://x.acme.workers.dev/" } })).toBeNull();
    expect(siteSource(null)).toBeNull();
  });
});

describe("siteDomains", () => {
  it("says which names a domain card attaches or takes off, and its link opens the website as it is", () => {
    const card = { site: { previewUrl: "https://happy-tails.acme.workers.dev/", domains: { hosts: ["pine.example", "www.pine.example"], zone: "pine.example" } } };
    expect(siteDomains(card)).toBe("Attaches: pine.example, www.pine.example");
    expect(siteDomains({ site: { domains: { hosts: ["www.pine.example"], zone: "pine.example", replaceRecords: true } } })).toBe("Attaches: www.pine.example (replaces their DNS records)");
    expect(siteDomains({ site: { domains: { hosts: ["www.pine.example"], zone: "pine.example", remove: true } } })).toBe("Takes off: www.pine.example");
    expect(siteDomains({ site: { domains: { hosts: ["pine.example\nAllow all"], zone: "x" } } })).toBeNull();
    expect(siteDomains({ site: { previewUrl: "https://x.acme.workers.dev/" } })).toBeNull();
    expect(siteDomains(null)).toBeNull();
    expect(sitePreview(card)).toBe("https://happy-tails.acme.workers.dev/");
    expect(sitePreviewLabel(card)).toBe("Open site");
    expect(sitePreviewLabel({ site: { previewUrl: "https://x.acme.workers.dev/" } })).toBe("Open preview");
  });
});


describe("siteShots", () => {
  const desk = { path: "/home/a/Spaces/tails/website-checks/ver1aaaa/home-desktop.jpg", name: "home-desktop.jpg", bytes: 2000, width: 1440, height: 3000 };
  const phone = { ...desk, path: desk.path.replace("desktop", "phone"), name: "home-phone.jpg", width: 390 };
  it("gives the check's screenshots, desktop then phone, and leaves anything odd out", () => {
    expect(siteShots({ site: { previewUrl: "https://x.acme.workers.dev/", shots: [desk, phone] } })).toEqual([desk, phone]);
    expect(siteShots({ site: { shots: [{ ...desk, path: "relative.jpg" }, { ...desk, path: "/a/../etc/x.jpg" }, { ...desk, path: "/a/x.svg" }, { ...desk, width: 0 }, phone] } })).toEqual([phone]);
    expect(siteShots({ site: { shots: [desk, phone, desk] } })).toHaveLength(2);
  });
  it("gives none on a domain card or a card from before the check", () => {
    expect(siteShots({ site: { domains: { hosts: ["pine.example"] }, shots: [desk] } })).toEqual([]);
    expect(siteShots({ site: { previewUrl: "https://x.acme.workers.dev/" } })).toEqual([]);
    expect(siteShots(null)).toEqual([]);
  });
});
