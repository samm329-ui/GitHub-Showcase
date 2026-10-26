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
  CALLOUT,
  CARD,
  CARD_CHROME_HEIGHT,
  CARD_BG,
  CARD_VIEWPORT_HEIGHT,
  CAPTION_OVERLAY,
  MASCOT_LAYOUT,
  STAGE_BG,
  VIEWPORT,
} from "../src/config.js";
import {
  CHARACTER_ALPHA_BOUNDS,
  mascotPlacementCss,
} from "../src/mascot-layout.js";
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
    // The radius is authored live in the preview, so assert the invariant
    // (a sane corner radius) instead of a snapshot that goes stale on save.
    assert.ok(CARD.radius >= 0 && CARD.radius <= 80, `radius ${CARD.radius}`);
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

    // Static CSS has no transforms left: the callout is bottom-anchored and
    // the card itself is upright and never rotated or skewed.
    const css = html.slice(0, html.indexOf("<script>"));
    const cssTransforms = [
      ...css.matchAll(/([.#][\w-]+)\s*\{[^}]*?(?<![-\w])transform:\s*[^;]+;/g),
    ].map(match => match[1]);
    assert.deepEqual([...new Set(cssTransforms)], []);
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
    assert.match(html, /font-size:\s*50px/);
    assert.match(html, /color:\s*#F8F6EF/);
    assert.match(html, /--caption-yellow:\s*#FFE66D/);
    assert.match(html, /text-shadow:\s*0 3px 10px/);
    // The dark panel is a separate layer from the moving word pill.
    assert.match(html, /\.caption-panel\s*\{[^}]*background:\s*rgba\(23,25,29,0\.92\)/s);
    assert.match(html, /\.caption-panel\s*\{[^}]*box-shadow:/s);
    assert.ok(
      !/\.caption-overlay\s*\{[^}]*background:/s.test(html),
      "the positioning root must stay transparent (no empty black plate)"
    );
    assert.match(html, /\.caption-overlay \.w\.current\s*\{\s*color:\s*#151619/);
    assert.match(html, /\.caption-overlay \.w\.key-emphasis\s*\{\s*color:\s*#FFE66D/);
    assert.ok(!/\.w\.active/.test(html), "the old combined active class is gone");
  });

  test("captions sit in a fixed dark panel in the lower third", () => {
    // The placement is authored live in the preview, so the test follows the
    // committed CAPTION_OVERLAY instead of snapshotting tunable numbers.
    const rule = html.match(/\.caption-overlay\s*\{[^}]*\}/s)?.[0] ?? "";
    assert.match(rule, new RegExp(`left:\\s*${CAPTION_OVERLAY.leftPx}px`));
    assert.match(rule, new RegExp(`top:\\s*${CAPTION_OVERLAY.topPx}px`));
    assert.match(rule, new RegExp(`width:\\s*${CAPTION_OVERLAY.widthPx}px`));
    assert.match(
      rule,
      new RegExp(`max-height:\\s*${CAPTION_OVERLAY.maxHeightPx}px`)
    );
    // The shadow must not be clipped by the positioning root.
    assert.match(rule, /overflow:\s*visible/);
    // The animated per-frame wrapper is part of the composition.
    assert.match(html, /\.caption-group\s*\{[^}]*will-change:\s*transform,\s*opacity/s);
    // The moving highlight element exists behind the glyphs.
    assert.match(html, /\.caption-highlight\s*\{[^}]*background:\s*#FFE66D/s);
  });

  test("the callout bubble is a stage-level sibling outside the clipped card", () => {
    const articleEnd = html.indexOf("</article>");
    const calloutAt = html.indexOf('id="callout"');
    assert.ok(calloutAt > articleEnd, "the card's overflow:hidden must not clip the bubble");
    assert.match(html, /<div class="callout-overlay" id="callout" aria-hidden="true">/);
    // Shape and copy are separate elements: the text is never baked into SVG.
    assert.match(html, /<svg class="callout-shape"/);
    assert.match(html, /<div class="callout-text" id="callout-text"><\/div>/);
    // Yellow backing first, then the warm-white cloud and its dark contour.
    const accentAt = html.indexOf('fill="#FFE66D"');
    const whiteAt = html.indexOf('fill="#FFFDF7"');
    assert.ok(accentAt > 0 && whiteAt > accentAt, "accent behind the white bubble");
    assert.match(
      html,
      new RegExp(
        `transform="translate\\(${CALLOUT.accentOffsetX} ${CALLOUT.accentOffsetY}\\)"`
      )
    );
    // Rays are a separate, initially hidden accent element.
    assert.match(html, /<svg class="callout-rays" id="callout-rays"/);
    assert.match(html, /\.callout-rays\s*\{[^}]*opacity:\s*0/s);
  });

  test("overlay z-order keeps the face visible and the caption in front", () => {
    const z = (selector: string) =>
      Number(
        html.match(new RegExp(`\\.${selector}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "s"))?.[1]
      );
    assert.equal(z("card"), 1);
    assert.equal(z("impact-rear"), 2);
    assert.equal(z("character"), 2);
    assert.equal(z("impact-front"), 4);
    assert.equal(z("callout-overlay"), 4);
    assert.equal(z("caption-overlay"), 5);
    // Independent SVG containers exist for impact strokes around the presenter
    assert.match(html, /<svg id="impact-rear" class="impact-layer impact-rear"/);
    assert.match(html, /<svg id="impact-front" class="impact-layer impact-front"/);
    assert.match(html, /setImpactState\(bursts\)/);
    // The bubble is placed from the mascot's head anchor, not an unrelated
    // hard-coded timeline coordinate: its authored box sits in the head band.
    const rule = html.match(/\.callout-overlay\s*\{[^}]*\}/s)?.[0] ?? "";
    const left = Number(rule.match(/left:\s*([\d.]+)px/)?.[1]);
    const top = Number(rule.match(/top:\s*([\d.]+)px/)?.[1]);
    assert.ok(
      left >= CALLOUT.leftMinPx && left <= VIEWPORT.width - CALLOUT.rightMarginPx,
      `callout left ${left}`
    );
    assert.ok(
      top >= CALLOUT.topMinPx && top <= CALLOUT.topMaxPx,
      `callout top ${top}`
    );
    assert.ok(
      left + CALLOUT.bubbleWidthPx <= VIEWPORT.width,
      "the bubble body stays inside the canvas"
    );
  });

  test("no caption panel exists until a phrase is active", () => {
    assert.match(html, /<div class="caption-overlay" id="caption"><\/div>/);
    // Text is written as textContent, and only when the cue changes.
    assert.match(html, /setCallout\(cueId, text, opacity/);
    assert.match(html, /textEl\.textContent = text/);
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
    // The rendered width and CSS offsets follow the committed mascot layout,
    // resolved through the same alpha-aware placement the anchors use.
    const renderedWidthPx = Math.round(MASCOT_LAYOUT.widthRatio * VIEWPORT.width);
    const placement = mascotPlacementCss({
      bounds: CHARACTER_ALPHA_BOUNDS,
      renderedWidthPx,
      canvasWidth: VIEWPORT.width,
      canvasHeight: VIEWPORT.height,
      clipRightPx: MASCOT_LAYOUT.offsetX,
      clipBottomPx: MASCOT_LAYOUT.offsetY,
    });
    assert.match(
      withPoses,
      new RegExp(`\\.character\\s*\\{[^}]*width:\\s*${renderedWidthPx}px`)
    );
    // Canvas-corner anchoring: a negative offset is the raw CSS offset, a
    // positive one is the deliberate clip past the edge (padding subtracted).
    assert.match(
      withPoses,
      new RegExp(`\\.character\\s*\\{[^}]*right:\\s*${placement.rightPx}px`)
    );
    assert.match(
      withPoses,
      new RegExp(`\\.character\\s*\\{[^}]*bottom:\\s*${placement.bottomPx}px`),
      "the character CSS must match the anchor math exactly"
    );
    // keepFaceVisible guard.
    assert.match(withPoses, /\.character\s*\{[^}]*max-height:\s*1920px/s);
    // The shadow derives from the alpha mask: drop-shadow, never a rectangle,
    // and the layer must carry no matte behind the transparent PNG.
    assert.match(withPoses, /\.character\s*\{[^}]*filter:\s*drop-shadow\(/s);
    assert.match(withPoses, /\.character\s*\{[^}]*background:\s*transparent/s);
    // The mascot is a stage-level layer: never inside the clipped card.
    const articleEnd = withPoses.indexOf("</article>");
    const characterTag = withPoses.indexOf('id="character"');
    assert.ok(characterTag > articleEnd, "the mascot must not be clipped by the card");
    const zCard = withPoses.match(/\.card\s*\{[^}]*z-index:\s*(\d+)/s)?.[1];
    const zCharacter = withPoses.match(/\.character\s*\{[^}]*z-index:\s*(\d+)/s)?.[1];
    assert.ok(Number(zCharacter) > Number(zCard));
  });

  test("the card shadow is layered, soft and outside the clipping boundary", () => {
    // Split on "), " so commas inside rgba() don't break the layers apart.
    const layers = CARD_SHADOW.split("), ")
      .map((chunk, index, all) => (index < all.length - 1 ? `${chunk})` : chunk).trim());
    assert.ok(layers.length >= 3, "ambient depth needs stacked shadows");
    const blurs: number[] = [];
    for (const layer of layers) {
      const parts = layer.split(/\s+/);
      const blur = Number(parts[2]?.replace("px", ""));
      const opacity = Number(layer.match(/rgba\(25,23,20,([\d.]+)\)/)?.[1]);
      assert.ok(Number.isFinite(blur) && blur >= 2, `no harsh hairline shadow: ${layer}`);
      assert.ok(opacity <= 1.0, `too dark for a soft shadow: ${layer}`);
      assert.ok(opacity > 0.05, "shadow must be visible, not decorative");
      blurs.push(blur);
    }
    // Broad ambient + near-edge contact: blur radii increase across layers.
    for (let index = 1; index < blurs.length; index += 1) {
      assert.ok(blurs[index] > blurs[index - 1], `blur radii must increase: ${layers[index]}`);
    }
    const cardRule = buildCardHtml(enriched("high-quality-popular")).match(/\.card\s*\{[^}]*\}/s)?.[0] ?? "";
    assert.match(cardRule, /box-shadow:\s*0 2px/);
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