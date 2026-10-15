# Showcase Frontend

Minimal SwiftUI entry point for the Node.js/TypeScript pipeline.

Build on macOS with Swift:

```bash
cd frontend
swift build
swift run ShowcaseFrontend
```

This frontend is macOS-only because SwiftUI requires Apple's SDK. It runs the existing pipeline with `npm run showcase` from the selected project directory.
