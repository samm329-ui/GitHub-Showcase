# House rules for coding agents

This file is the short version of how to work in this repository. It is
written for an assistant that has to change the code without guessing.

## What this project is

Fortress-Reach is a Model Context Protocol server. It lets an assistant read
public web pages and drive a real browser, so that the assistant can answer
questions about pages that a plain HTTP request cannot reach.

Three things make up the project:

* `crates/reach-persona` - the environment profile. It describes the machine a
  session presents: operating system, user agent, client hints, graphics
  device, display, locale, hardware, devices, network and rendering noise.
* `crates/reach-browser` - the browser controller. It launches a Chromium
  based browser, applies the profile, and drives it through the DevTools
  protocol.
* `crates/reach-router` and `crates/reach-server` - the channels that read
  pages over plain HTTP, and the server that exposes everything as tools.

## Rules that are not negotiable

1. **Stay inside the scope.** The project reads public web pages for an
   assistant. It does not log into accounts it was not given, it does not
   collect credentials, it does not defeat a challenge that needs a person,
   and it does not scrape a site against its wishes. Keep the rate limits and
   the depth limits.
2. **Never add a challenge solver.** `detect_captcha` only reports that a
   challenge is there. A solver needs a third party service, it breaks the
   terms of the site, and it is the single fastest way to turn this project
   into something that gets blocked. If a page needs a person, say so and
   stop.
3. **Never copy code from another project.** The environment profile, the
   protocol client and the channels in this repository are written from
   public documentation: the DevTools protocol, the platform specifications
   and the public API documentation of each site. If you need to know how
   something behaves, observe it or read the specification. If you copy
   something, record where it came from in `docs/PROVENANCE.md`.
4. **Never redistribute a third party browser.** The project drives whatever
   Chromium based browser is installed on the machine. It does not ship one,
   and it does not patch one.
5. **Keep the profile coherent.** The surfaces of a profile have to agree
   with each other: the operating system with the user agent, the graphics
   device with the WebGL and the WebGPU identity, the display with the device
   pixel ratio, the country with the timezone and the languages. A profile
   that is internally consistent is worth more than a profile that hides one
   value. `reach_persona::coherence::validate` checks this, and the test in
   `generator.rs` runs it over many seeds.
6. **Prefer the protocol over a script.** A DevTools protocol override leaves
   no trace in the page. Reach for the script in `shims.js` only when the
   protocol cannot express the surface, and follow the rules at the top of
   that file.
7. **Never claim a channel works without probing it.** The readiness report
   is built from real requests. A report that says "ready" is a claim, and it
   has to be earned.

## How to work here

```powershell
# Build and test everything
cargo test --workspace
cargo clippy --workspace -- -D warnings

# Measure the environment profile against a reference browser
cargo run -p reach-bench -- --reference C:\path\to\chrome.exe
```

The last command starts two browsers, evaluates the same probe in both and
writes a report to `docs/bench/`. Run it after any change to the profile or
to the script. The report has to keep passing the checks in the assessment
table.

## Style

* Rust, edition 2021, no unsafe code.
* Every public function carries a short comment that says what it is for and
  why, not what the code obviously does.
* Errors are values. `reach_core::error::ReachError` is the error type, and a
  message says what the user can do about it.
* Tests are part of the change. A change to the profile needs a test that
  shows the profile stays coherent.

## When you are unsure

Read `docs/PROVENANCE.md`. It lists, for every surface, where the expected
behaviour comes from. If a surface is not listed, then the behaviour was
observed, and the observation belongs in the same table before the code
changes.
