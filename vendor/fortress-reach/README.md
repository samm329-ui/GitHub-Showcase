# Fortress-Reach

A Model Context Protocol server that lets an assistant read public web pages
and drive a real browser, so that it can answer questions about pages that a
plain HTTP request cannot reach.

**One project, one binary, no runtime dependencies.** No Node.js, no npm, no
Python, no downloaded browser, and no dependency on anyone else's repository.

---

## What it is made of

```text
E:\fortress-reach/
├── Cargo.toml                      # Workspace root and shared build profile
├── AGENTS.md                       # House rules for coding agents
├── NOTICE                          # Attribution
├── docs/
│   ├── PROVENANCE.md               # Where the expected behaviour of every surface comes from
│   ├── CAPABILITY-MATRIX.md        # What the project covers, measured against a reference browser
│   └── bench/                      # The measured reports
└── crates/
    ├── reach-core/                 # Shared models, errors and configuration
    ├── reach-persona/              # The environment profile: generator, coherence rules, noise
    ├── reach-router/               # Multi platform channels over plain HTTP
    ├── reach-browser/              # The browser controller, the protocol client and the profile
    ├── reach-server/               # The MCP server and the tunnel manager
    ├── reach-app/                  # The desktop program
    └── reach-bench/                # The comparison harness
```

## The environment profile

The interesting part of this project is not the reading, it is the machine
that the session appears to run on.

A profile is a complete description of one machine: the operating system, the
user agent and the client hints, the graphics device, the display, the
locale, the hardware, the devices, the network and the rendering noise. It is
generated as a whole from one seed, so that every surface agrees with every
other surface. A machine that is half plausible and half impossible is worse
than a machine that is plainly default, because the disagreement is the
signal.

Three properties are worth calling out.

* **The browser version is not invented.** The user agent and the client
  hints name the version of the browser that is actually running. A user
  agent that says one version while the client hints say another is a
  contradiction that costs nothing to avoid.
* **The noise is not reproducible.** The machine can be pinned with a seed,
  but the canvas and audio offsets are derived from a secret that is new in
  every session and are then keyed per site, so a page sees a stable value
  for the whole session while two sessions never share a fingerprint.
* **The protocol is preferred.** Where the DevTools protocol can set a
  surface, it is set there, because a protocol override leaves no trace in
  the page. The injected script only covers what the protocol cannot reach,
  and it is written to look native: the overridden functions report native
  source, and every function the page itself defines still reports its own.

The profile is validated as a whole. `reach_persona::coherence::validate`
rejects a profile that mixes a macOS system with a Direct3D graphics device,
a device memory value outside the range the specification allows, an
available area larger than the screen, a language that does not match the
country, and a set of other contradictions.

## The browser

The project drives whatever Chromium based browser is installed on the
machine. It never hardcodes a path to a particular build, and it never ships
one.

```powershell
# Use a specific browser for one session
$env:REACH_BROWSER_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"

# Pin the machine, and pin it to a country
$env:REACH_PERSONA_SEED = "20260101"
$env:REACH_PERSONA_COUNTRY = "DE"
```

A build that understands the extended switch vocabulary is used with it
automatically, and the project finds out by looking for the switch names in
the binary, so nothing has to be configured and nothing has to be present.

Interaction is done with real input. Clicks and key presses are delivered
through the input domain of the protocol, so the page sees trusted events,
and a page that waits for a real click gets one.

## The tools

Thirty five tools are exposed over the Model Context Protocol.

| Group | Tools |
| --- | --- |
| Reading | `read_page`, `fetch_protected_page`, `get_page_html`, `read_tweet`, `read_reddit`, `read_github`, `read_rss`, `get_youtube_transcript`, `search_web` |
| Structure | `extract_page`, `extract_document`, `page_elements`, `crawl_site`, `recon_site_apis` |
| Interaction | `click_button`, `fill_field`, `press_key`, `wait_for`, `current_page`, `run_browser_task`, `list_browser_tasks` |
| Capture | `screenshot_page`, `save_page`, `download_file` |
| Session | `get_cookies`, `save_profile`, `load_profile`, `list_tabs`, `close_tab` |
| Diagnostics | `detect_waf`, `detect_captcha`, `doctor_status`, `get_egress_info`, `evaluate_js`, `get_stealth_cdp_endpoint` |

`detect_captcha` reports that a challenge is there. It does not solve one: a
challenge that needs a person needs a person.

`doctor_status` probes every channel for real and reports what it found,
including how long each one took to answer. It never reports a channel as
ready without having asked it.

## The server

The server speaks the Model Context Protocol over Server-Sent Events and over
streamable HTTP, and it can publish itself to the internet with a Cloudflare
quick tunnel, so that a phone or a web client can reach it without any port
forwarding.

```powershell
cargo run -p reach-app
```

The desktop program shows the tunnel address, the readiness report and the
log, and it copies the address to the clipboard with one click.

## Building and testing

```powershell
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo build --release -p reach-app
```

The release build is a single program at `target\release\fortress-reach.exe`.

## Measuring the result

The comparison harness starts two browsers, evaluates the same probe in both
and writes a report.

```powershell
cargo run -p reach-bench -- --reference C:\path\to\chrome.exe
```

The report lists every surface, the value in each browser and a set of
checks that decide whether a session looks like a browser that a person
actually used. The current result is in `docs/CAPABILITY-MATRIX.md`, and the
raw report is in `docs/bench/`.

## What this project does not do

* It does not collect credentials, and it does not log into accounts.
* It does not solve challenges, and it does not defeat a licence check.
* It does not scrape a site against its wishes; the depth limits and the
  rate limits in the code are there on purpose.
* It does not redistribute a third party browser, and it does not copy code
  from another project. `docs/PROVENANCE.md` records where the expected
  behaviour of every surface comes from.
