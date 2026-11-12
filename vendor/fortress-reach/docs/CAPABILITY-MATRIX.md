# Capability matrix

This file records what the project can do, and how it compares with a
reference browser that was measured side by side with it.

## How the numbers were produced

```powershell
cargo run -p reach-bench -- --reference C:\path\to\chrome.exe
```

The harness starts two browsers, evaluates the same probe file
(`crates/reach-bench/probe.js`) in both, and writes the report to
`docs/bench/`. The report is the raw evidence; this file is the reading of
it. The reference can also be named with the `REACH_REFERENCE_BROWSER`
environment variable, and the comparison is optional: the project never
needs a second browser.

The reference used for the numbers below is a Chromium build that carries a
patched environment: it changes the surfaces at the source level, so no
script is needed to see the change. The build reports itself as running in
its public first generation mode, which is the mode that needs no licence
key. That mode covers roughly thirty surfaces.

## Result

| | Reference | Fortress-Reach |
| --- | --- | --- |
| Surfaces that pass the assessment | 13 of 17 | **17 of 17** |
| Automation flag | cleared | cleared |
| Screen size | 800 by 600, the headless default | a real resolution |
| Device memory | 16, outside the range the specification allows | a legal value |
| Graphics identity | WebGL says one device, WebGPU says another | one device on both channels |
| Storage quota | the flat sandbox default | scaled to the machine |
| Window frame | window smaller than the screen | window smaller than the screen |
| Timezone and language | the host values | the values of the profile |
| Browser version in the user agent | 153 | the version that is running |

The four failures of the reference are not differences of taste. They are
the surfaces where the reference leaks the machine it runs on, or contradicts
itself. The project does not have to patch a browser to avoid them: the
values come from the protocol, and the protocol leaves no trace.

## What the project covers

| Family | Surfaces |
| --- | --- |
| Identity | user agent, client hints with the high entropy values, platform, vendor, brand list, language list |
| Display | screen size, available area, colour depth, pixel ratio, window size, colour gamut, dynamic range, colour scheme |
| Locale | timezone, languages, date formatting |
| Graphics | WebGL vendor, renderer, version, shading language, numeric limits, precision, extension list, WebGPU adapter with its limits and features |
| Hardware | core count, device memory |
| Rendering noise | canvas, WebGL readback, audio output, text metrics, element geometry |
| Devices | media devices, battery, keyboard layout, speech voices, font families |
| Network | round trip time, downlink, effective type, data saver, WebRTC candidate policy |
| Storage | storage quota |

## What the protocol cannot reach

Some surfaces exist only inside the browser process and cannot be changed
from outside. They are listed here so that the limit is written down rather
than discovered later.

* The exact font rasterisation and the real font metrics of the host.
* The behaviour of a video codec that the installed browser does not have.
* The presence of a hardware camera, microphone or speaker.
* The `Math.random` generator of the engine.

For these, the project uses the closest honest value and keeps it
consistent with the rest of the profile, rather than pretending that the
surface does not exist.

## The two ways to run

| | Provider | What it is |
| --- | --- | --- |
| Default | The Chromium based browser that is installed on the machine | Nothing is downloaded, nothing is patched, and the profile is applied through the protocol. |
| Optional | A browser build that accepts the extended switch vocabulary | The profile is passed as switches as well, so that a build that acts on them can apply the surfaces that it can apply itself. The project finds out which switch names the build knows by looking for them in the binary, and it never requires this build to be present. |

The profile is applied through the protocol and the script in both cases.
That is deliberate: a build in the public first generation mode carries the
vocabulary but does not act on it, so relying on the switches alone would
leave every surface at the host value. The protocol route is the one route
that is known to work on every build.

## What the reference build does with the switch vocabulary

This was measured, not assumed. A build that carries the vocabulary was
started with the switches of a profile and read back:

| Switch | Effect in the public first generation mode |
| --- | --- |
| `--uxr-languages` | no effect, the host language stayed |
| `--uxr-timezone` | no effect, the host timezone stayed |
| `--uxr-screen-width` and `--uxr-screen-height` | no effect, the headless default stayed |
| `--uxr-hw-concurrency` and `--uxr-device-memory` | no effect, the host values stayed |
| `--uxr-storage-quota` | no effect, the sandbox default stayed |
| `--uxr-webgl-renderer` | no effect, the build's own fixed renderer string stayed |

The build answered the only questions it answers in that mode: the user
agent carries no headless token, the automation flag is off, and the WebGL
identity is the one the build carries. Everything else it leaves to the
machine it runs on, which is why the reference shows a screen of 800 by 600
and a quota of ten gigabytes.

## Keeping the report honest

The harness is a gate, not a demonstration. After any change to the profile
or to the script, run it again and keep the new report. The assessment in
the report has to stay at seventeen of seventeen.
