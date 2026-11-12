# Provenance

For every surface that this project reproduces, this table records where the
expected behaviour comes from. The rule is simple: a surface that is not
listed here was observed, and the observation has to be added here before the
code that depends on it changes.

The project is an independent implementation. It reads the public
documentation of the protocols and the platforms it touches, and it observes
behaviour through the DevTools protocol. It does not copy code.

## Identity

| Surface | Where the behaviour comes from |
| --- | --- |
| `navigator.userAgent` shape | The user agent reduction rules of the Chromium project. The build is read from the browser itself, so the version in the string is always the version that is running. |
| `navigator.userAgentData` fields | The User-Agent Client Hints specification. |
| `navigator.platform` | The historical values `Win32` and `MacIntel`. This is not the same string as the client hint platform (`Windows`, `macOS`), and the two are kept apart on purpose. |
| Brand list and the grease entry | The client hint specification, which reserves one brand for compatibility testing. The order is randomised by the browser, so the project randomises it too. |

## Display

| Surface | Where the behaviour comes from |
| --- | --- |
| `screen.width` and `screen.height` | The CSSOM View specification. |
| `screen.availWidth` and `screen.availHeight` | The CSSOM View specification. The reserved area is the platform convention: a task bar on Windows, a menu bar on macOS. |
| `devicePixelRatio` | The CSSOM View specification. |
| `outerWidth` and `outerHeight` | The CSSOM View specification. A window is always larger than the area it shows. |

## Locale

| Surface | Where the behaviour comes from |
| --- | --- |
| Timezone identifiers | The IANA time zone database. |
| Language and region pairs | The Unicode CLDR. |
| Keyboard layout maps | The platform keyboard documentation (the W3C UI Events code values). |

## Graphics

| Surface | Where the behaviour comes from |
| --- | --- |
| `UNMASKED_VENDOR_WEBGL` and `UNMASKED_RENDERER_WEBGL` | The WebGL specification, and the renderer strings that the graphics vendors publish for their drivers. |
| WebGL numeric limits | The WebGL specification. The values are the ones the named device reports. |
| `GL_VERSION` and `GL_SHADING_LANGUAGE_VERSION` | The WebGL and OpenGL ES specifications. |
| `navigator.gpu` adapter fields | The WebGPU specification. The vendor and the architecture have to name the same device as the WebGL identity, otherwise the two channels contradict each other. |

## Rendering noise

| Surface | Where the behaviour comes from |
| --- | --- |
| Canvas and WebGL readback noise | The WebGL and HTML canvas specifications do not define a noise model, so the model is this project's own: a value dependent offset of at most one unit per channel, keyed per site, applied to every read path so that the paths agree with each other. |
| Audio output noise | The Web Audio specification. The offset is far below the perceptible threshold, and the same key is used for the buffer and the analyser so that the two agree. |
| Text metrics | The Canvas specification. The variation is stable for the same text in the same font, so that a page cannot be told apart by reading the same string twice. |

## Storage, devices and network

| Surface | Where the behaviour comes from |
| --- | --- |
| `navigator.storage.estimate` | The Storage specification. |
| `navigator.mediaDevices.enumerateDevices` | The Media Capture and Streams specification. Before a permission is granted the labels are empty, and the order is the one the specification fixes. |
| `navigator.getBattery` | The Battery Status specification. A charging battery has no discharge time, and a discharging one has no charge time. |
| `navigator.connection` | The Network Information specification. The round trip time and the downlink have to agree with the effective type. |
| WebRTC candidate policy | The WebRTC specification, and the browser switch that keeps the local address out of the candidate list. |

## Automation surfaces

| Surface | Where the behaviour comes from |
| --- | --- |
| `navigator.webdriver` | The WebDriver specification, and the Chromium switch that keeps the automation flag out of the navigator. The switch is used instead of a script, so the value is native. |
| Trusted input | The DevTools protocol input domain. Events that are delivered by the browser carry the trusted flag, events that are created in the page do not. |
| Page load waiting | The DevTools protocol lifecycle events, instead of a fixed pause. |

## Observed behaviour

The following were observed on the reference browser and are recorded here
because they are not described by a specification.

| Observation | What was seen |
| --- | --- |
| Headless screen default | A headless browser reports an 800 by 600 screen. The profile therefore always sets a real resolution. |
| Client hint and user agent version | A user agent that names one version while the client hints name another is a contradiction, so both are taken from the browser that is running. |
| Storage quota default | A sandboxed browser reports a flat ten gigabyte quota, so the profile sets a quota that scales with the machine. |
| WebGL and WebGPU disagreement | A browser can advertise one graphics device through WebGL and a different one through WebGPU. The profile keeps them on the same device. |
| Device memory range | The specification caps the reported value, so the profile only uses the values the specification allows. |
| Extended switch vocabulary | A build can carry a vocabulary of switches and still not act on it. Measured on a build in the public first generation mode: the switches for the language, the timezone, the screen, the core count, the device memory, the storage quota and the graphics renderer had no effect, while the values that the build always applies did apply. The project therefore applies the profile through the protocol, and sends a switch only when the binary carries its name. |

## How to add a surface

1. Find the specification that describes it and write the row down.
2. Express it in the profile (`crates/reach-persona`).
3. If the DevTools protocol can set it, add a protocol override
   (`crates/reach-browser/src/fingerprint.rs`). A protocol override leaves no
   trace in the page.
4. Only if the protocol cannot express it, add it to the script
   (`crates/reach-browser/src/shims.js`) and follow the rules at the top of
   that file.
5. Add the surface to the probe (`crates/reach-bench/probe.js`) and to the
   assessment in the bench, so that the change is measured.
6. Run `cargo run -p reach-bench` and keep the report in `docs/bench/`.
