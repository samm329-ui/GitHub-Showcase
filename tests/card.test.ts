import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  buildCardHtml,
  buildDocument,
  CARD_SHADOW,
  sanitizeReadmeHtml,
} from "../src/card.js";
import { clampScroll, isScrollable, scrollBounds, targetForAnchor } from "../src/scroll.js";
import {
  CARD,
  CARD_CAPTION_ZONE,
  CARD_CHROME_HEIGHT,
  CARD_PROGRESS_ZONE,
  CARD_BG,
  STAGE_BG,
  VIEWPORT,
} from "../src/config.js";
import { enriched } from "./helpers.js";

describe("composition geometry", () => {
  test("the canvas is exactly 1080x1920", () => {
    assert.equal(VIEWPORT.width, 1080);
    assert.equal(VIEWPORT.height, 1920);
    assert.equal((VIEWPORT.width / VIEWPORT.height).toFixed(4), "0.5625");
  });

  test("the card is 810x1668 and centred", () => {
    assert.equal(CARD.width, 810);
    assert.equal(CARD.height, 1668);
    assert.equal(CARD.left, 135);
    assert.equal(CARD.top, 126);
    assert.equal(CARD.left * 2 + CARD.width, VIEWPORT.width);
    assert.equal(CARD.top * 2 + CARD.height, VIEWPORT.height);
  });

  test("the card uses the required colours and radius", () => {
    assert.equal(STAGE_BG, "#F2EFE9");
    assert.equal(CARD_BG, "#0D1117");
    assert.equal(CARD.radius, 28);
  });

  test("the shadow is neutral and diffuse", () => {
    assert.match(CARD_SHADOW, /rgba\(25,23,20/);
    assert.equal(CARD_SHADOW.match(/rgba\(/g)?.length, 4, "four neutral layers");
    assert.ok(!/255|255,255/.test(CARD_SHADOW), "no bright or coloured glow");
  });

  test("the vertical zones exactly fill the card", () => {
    assert.equal(
      CARD_CHROME_HEIGHT + (CARD.height - CARD_CHROME_HEIGHT - CARD_CAPTION_ZONE - CARD_PROGRESS_ZONE) + CARD_CAPTION_ZONE + CARD_PROGRESS_ZONE,
      CARD.height
    );
  });
});

describe("stationary card markup", () => {
  const html = buildCardHtml(enriched("high-quality-popular"));

  test("the stage is a flat solid background", () => {
    assert.match(html, /\.stage\s*\{[^}]*background:\s*var\(--stage-bg\)/);
    assert.ok(!/linear-gradient/.test(html.split(".card")[0]), "no decorative scenery in the stage");
  });

  test("the card is upright with no perspective or rotation", () => {
    assert.ok(!/perspective/.test(html));
    assert.ok(!/rotate3d|rotateX|rotateY|skew/.test(html));
    assert.ok(!/rotate\(/.test(html));
  });

  test("there is no phone frame or device mock", () => {
    assert.ok(!/phone|mockup|device-frame|notch/i.test(html));
  });

  test("the card clips its overflow so content cannot escape", () => {
    assert.match(html, /\.card\s*\{[\s\S]*?overflow:\s*hidden/);
    assert.match(html, /\.viewport\s*\{[\s\S]*?overflow:\s*hidden/);
  });

  test("only the document layer is animated", () => {
    // The only place a runtime transform is written is the scroll hook.
    const hooks = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
    const transforms = [
      ...hooks.matchAll(/getElementById\('([^']+)'\)\.style\.transform/g),
    ].map(match => match[1]);
    assert.deepEqual(transforms, ["document"]);

    // Static CSS transforms are limited to centring a small decorative dot.
    const css = html.slice(0, html.indexOf("<script>"));
    const cssTransforms = [
      ...css.matchAll(/([.#][\w-]+)\s*\{[^}]*?(?<![-\w])transform:\s*[^;]+;/g),
    ].map(match => match[1]);
    assert.deepEqual([...new Set(cssTransforms)], [".thumb"]);
  });

  test("captions and progress live inside the card", () => {
    assert.match(html, /<div class="caption-zone">[\s\S]*?<div class="caption" id="caption">/);
    assert.match(html, /<div class="progress">[\s\S]*?id="time"/);
  });

  test("the caption style matches the specification", () => {
    assert.match(html, /font-size:\s*34px/);
    assert.match(html, /color:\s*#FFFFFF/);
    assert.match(html, /--caption-yellow:\s*#FFD629/);
    assert.match(html, /text-shadow:\s*0 2px 5px/);
    assert.ok(
      !/\.caption\s*\{[^}]*background:/s.test(html),
      "captions must not draw a filled background box"
    );
    assert.ok(!/\.hl\s*\{[^}]*background:/s.test(html), "highlights are colour only");
  });

  test("the browser bar shows the real repository URL", () => {
    assert.match(html, /github\.com\/acme\/rocket-cli/);
  });
});

describe("card document", () => {
  test("only sections that exist produce anchors", () => {
    const withInstall = buildDocument(enriched("high-quality-popular"));
    assert.match(withInstall, /data-anchor="repo-header"/);
    assert.match(withInstall, /data-anchor="file-list"/);
    assert.match(withInstall, /data-anchor="readme-intro"/);
    assert.match(withInstall, /data-anchor="install-command"/);
    assert.match(withInstall, /data-anchor="features"/);
    assert.match(withInstall, /data-anchor="license"/);
  });

  test("an anchor is omitted when the repository has no such content", () => {
    const bare = buildDocument(
      enriched("high-quality-popular", {
        readmeText: "# Project\n\nA short description.",
        rootFiles: [],
      })
    );
    assert.ok(!/data-anchor="install-command"/.test(bare));
    assert.ok(!/data-anchor="file-list"/.test(bare));
    assert.ok(!/data-anchor="features"/.test(bare));
    assert.match(bare, /data-anchor="repo-header"/);
    assert.match(bare, /data-anchor="readme-intro"/);
  });

  test("star counts come from the API, never invented", () => {
    const doc = buildDocument(enriched("high-quality-popular"));
    assert.match(doc, /18\.4 thousand|18400/);
  });

  test("a repository with no license says so instead of guessing", () => {
    const doc = buildDocument(enriched("no-license"));
    assert.match(doc, /not identified/i);
    assert.ok(!/MIT/.test(doc));
  });
});

describe("README sanitization", () => {
  test("script blocks are removed", () => {
    const html = sanitizeReadmeHtml(
      "# Title\n\nBefore\n\n<script>alert('xss')</script>\n\nAfter"
    );
    assert.ok(!/<script/i.test(html));
    assert.ok(!/alert\(/.test(html));
    assert.match(html, /Before/);
    assert.match(html, /After/);
  });

  test("style, iframe and object blocks are removed", () => {
    const html = sanitizeReadmeHtml(
      "<style>body{display:none}</style><iframe src='https://evil'></iframe><object data='x'></object>Text"
    );
    assert.ok(!/<style|<iframe|<object/i.test(html));
    assert.match(html, /Text/);
  });

  test("remote images and URLs are not loaded or shown", () => {
    const html = sanitizeReadmeHtml(
      "![logo](https://evil.example/logo.png) See https://evil.example/page and <img src=x onerror=alert(1)>"
    );
    assert.ok(!/<img/i.test(html));
    assert.ok(!/evil\.example/.test(html));
    assert.ok(!/onerror/.test(html));
  });

  test("links keep their text but not their target", () => {
    const html = sanitizeReadmeHtml("Read the [documentation](https://example.com/docs).");
    assert.match(html, /documentation/);
    assert.ok(!/example\.com/.test(html));
  });

  test("markdown structure becomes readable HTML", () => {
    const html = sanitizeReadmeHtml(
      "# Title\n\n## Features\n\n- One\n- Two\n\n```bash\nnpm install x\n```"
    );
    assert.match(html, /<h2>Title<\/h2>/);
    assert.match(html, /<h3>Features<\/h3>/);
    assert.match(html, /<li>One<\/li>/);
    assert.match(html, /<pre class="code"/);
    assert.match(html, /npm install x/);
  });

  test("angle brackets in prose cannot become markup", () => {
    const html = sanitizeReadmeHtml("Use <div onmouseover=alert(1)> carefully.");
    assert.ok(!/<div/i.test(html));
    assert.match(html, /&lt;div/);
  });

  test("an empty README produces an empty result rather than a crash", () => {
    assert.equal(sanitizeReadmeHtml("").trim(), "");
  });
});

describe("scroll anchors", () => {
  const bounds = scrollBounds(2060, 1310);

  test("bounds are derived from the measured document", () => {
    assert.equal(bounds.maxScroll, 750);
    assert.equal(isScrollable(bounds), true);
    assert.equal(isScrollable(scrollBounds(1400, 1310)), false);
  });

  test("targets are aligned to the top of the viewport", () => {
    const target = targetForAnchor(
      { anchor: "readme-intro", offsetTop: 600, offsetHeight: 900 },
      bounds,
      48
    );
    assert.equal(target, 552);
  });

  test("targets never exceed the maximum scroll", () => {
    const target = targetForAnchor(
      { anchor: "license", offsetTop: 3000, offsetHeight: 200 },
      bounds,
      48
    );
    assert.equal(target, 750);
  });

  test("targets never go negative", () => {
    assert.equal(
      targetForAnchor({ anchor: "repo-header", offsetTop: 0, offsetHeight: 400 }, bounds),
      0
    );
  });

  test("clamping rejects non-finite input", () => {
    assert.equal(clampScroll(Number.NaN, bounds), 0);
    assert.equal(clampScroll(Number.POSITIVE_INFINITY, bounds), 750);
    assert.equal(clampScroll(-500, bounds), 0);
  });

  test("a zero-height anchor is ignored rather than scrolled to", () => {
    assert.equal(
      targetForAnchor({ anchor: "repo-header", offsetTop: 500, offsetHeight: 0 }, bounds),
      0
    );
  });
});