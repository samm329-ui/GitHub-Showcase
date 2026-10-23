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
  CARD_CHROME_HEIGHT,
  CARD_BG,
  CARD_VIEWPORT_HEIGHT,
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

  test("the page viewport fills the card below the browser chrome", () => {
    assert.equal(CARD_VIEWPORT_HEIGHT, CARD.height - CARD_CHROME_HEIGHT);
    assert.equal(CARD_CHROME_HEIGHT + CARD_VIEWPORT_HEIGHT, CARD.height);
  });
});

describe("stationary card markup", () => {
  const html = buildCardHtml(enriched("high-quality-popular"));

  test("the stage is a flat solid background", () => {
    assert.match(html, /\.stage\s*\{[^}]*background:\s*var\(--stage-bg\)/);
    assert.ok(!/linear-gradient/.test(html.split(".card")[0]), "no decorative scenery in the stage");
  });

  test("the card is upright with no perspective or rotation", () => {
    const cardRule = html.match(/\.card\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.ok(!/perspective|rotate|skew|transform/i.test(cardRule));
    assert.ok(!/rotate3d|rotateX|rotateY|skew/.test(html));
  });

  test("there is no phone frame or device mock", () => {
    assert.ok(!/phone|mockup|device-frame|notch/i.test(html));
  });

  test("the card clips its overflow so content cannot escape", () => {
    assert.match(html, /\.card\s*\{[\s\S]*?overflow:\s*hidden/);
    assert.match(html, /\.viewport\s*\{[\s\S]*?overflow:\s*hidden/);
  });

  test("only the scrolling document layer is translated", () => {
    const hooks = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
    // The scroll hook is the only place a layer's transform is written from JS.
    assert.match(hooks, /documentLayer\.style\.transform\s*=\s*'translate3d/);
    // The character may also be posed, but it is an independent stage layer.
    assert.match(hooks, /character\.style\.transform\s*=/);
    assert.ok(!/setProgress/.test(hooks));

    // Static CSS transforms are limited to centring the caption overlay. The
    // card itself is upright and never rotated or skewed.
    const css = html.slice(0, html.indexOf("<script>"));
    const cssTransforms = [
      ...css.matchAll(/([.#][\w-]+)\s*\{[^}]*?(?<![-\w])transform:\s*[^;]+;/g),
    ].map(match => match[1]);
    assert.deepEqual([...new Set(cssTransforms)], [".caption-overlay"]);
  });

  test("captions float over the page and there is no progress UI", () => {
    assert.match(html, /<div class="viewport" id="viewport">[\s\S]*?<div class="caption-overlay" id="caption">/);
    assert.ok(!/class="progress|id="time"|class="track|class="thumb|class="fill/i.test(html));
    assert.ok(
      !/setProgress|progress-zone|caption-zone/i.test(html),
      "the removed preview controls must not survive anywhere in the composition"
    );
  });

  test("the caption style matches the specification", () => {
    assert.match(html, /font-size:\s*42px/);
    assert.match(html, /color:\s*#FFFFFF/);
    assert.match(html, /--caption-yellow:\s*#FFD629/);
    assert.match(html, /text-shadow:\s*0 2px 2px/);
    assert.match(html, /-webkit-text-stroke:/);
    assert.ok(
      !/\.caption-overlay\s*\{[^}]*background:/s.test(html),
      "captions must not draw a filled background box"
    );
    assert.ok(!/\.hl\s*\{[^}]*background:/s.test(html), "highlights are colour only");
  });

  test("the character layer is optional and independent of the card", () => {
    assert.ok(!/id="character"/.test(html), "no character image without an asset URL");
    const withCharacter = buildCardHtml({
      repo: enriched("high-quality-popular"),
      pageImageUrl: "http://127.0.0.1/page.jpg",
      characterUrl: "http://127.0.0.1/character.png",
    });
    assert.match(withCharacter, /<img id="character" class="character"/);
    assert.match(withCharacter, /id="mobile-page"/);
    assert.match(withCharacter, /setCharacterPose/);
  });

  test("named presenter poses are stacked layers, not a swapped src", () => {
    const withPoses = buildCardHtml({
      repo: enriched("high-quality-popular"),
      pageImageUrl: "http://127.0.0.1/page.jpg",
      characterPoses: [
        { pose: "present", url: "http://127.0.0.1/present.png" },
        { pose: "point", url: "http://127.0.0.1/point.png" },
        { pose: "close", url: "http://127.0.0.1/close.png" },
      ],
    });
    assert.match(withPoses, /data-pose="present"/);
    assert.match(withPoses, /data-pose="point"/);
    assert.match(withPoses, /data-pose="close"/);
    const hooks = withPoses.slice(withPoses.indexOf("<script>"), withPoses.indexOf("</script>"));
    assert.match(hooks, /layer\.getAttribute\('data-pose'\) === requested/);
    assert.match(hooks, /layer\.style\.opacity/);
  });

  test("the mascot is anchored to the canvas corner, sized by canvas width", () => {
    const withPoses = buildCardHtml({
      repo: enriched("high-quality-popular"),
      pageImageUrl: "http://127.0.0.1/page.jpg",
      characterPoses: [
        { pose: "present", url: "http://127.0.0.1/present.png" },
        { pose: "close", url: "http://127.0.0.1/close.png" },
      ],
    });
    // 0.46 * 1080 canvas width = 497px.
    assert.match(withPoses, /\.character\s*\{[^}]*width:\s*497px/s);
    // -12px pushes the layer past the right edge; 0px sits flush on the
    // bottom edge. The viewport clip handles the overflow.
    assert.match(withPoses, /\.character\s*\{[^}]*right:\s*-12px/s);
    assert.match(withPoses, /\.character\s*\{[^}]*bottom:\s*0px/s);
    // keepFaceVisible guard.
    assert.match(withPoses, /\.character\s*\{[^}]*max-height:\s*1920px/s);
    // The mascot is a stage-level layer: never inside the clipped card.
    const articleEnd = withPoses.indexOf("</article>");
    const characterTag = withPoses.indexOf('id="character"');
    assert.ok(characterTag > articleEnd, "the mascot must not be clipped by the card");
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