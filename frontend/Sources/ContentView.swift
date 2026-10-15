import SwiftUI

struct ContentView: View {
    @State private var projectPath = NSHomeDirectory() + "/github-showcase"
    @State private var repository = ""
    @State private var discover = false
    @State private var log = ""
    @State private var running = false

    var body: some View {
        VStack(spacing: 16) {
            Text("GitHub Showcase Pipeline")
                .font(.title2.weight(.semibold))

            TextField("Project path", text: $projectPath)
                .textFieldStyle(.roundedBorder)

            TextField("Repository URL or owner/repo", text: $repository)
                .textFieldStyle(.roundedBorder)
                .disabled(discover)

            Toggle("Discover repository automatically", isOn: $discover)

            Button(running ? "Running..." : "Run Pipeline") {
                Task { await runPipeline() }
            }
            .disabled(running)

            if running {
                ProgressView()
            }

            ScrollView {
                Text(log)
                    .font(.system(.body, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(minHeight: 240)
            .background(Color.black.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .padding(24)
        .frame(width: 680, height: 520)
    }

    @MainActor
    private func runPipeline() async {
        running = true
        log = "Starting...\n"
        let task = Task.detached(priority: .userInitiated) { () -> String in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            var arguments = ["npm", "run", "showcase", "--"]
            if discover {
                arguments.append("--discover")
            } else if !repository.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                arguments += ["--repo", repository]
            }
            process.arguments = arguments
            process.currentDirectoryURL = URL(fileURLWithPath: projectPath)

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()
                process.waitUntilExit()
                let out = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                return (out + err + "\nExit code: \(process.terminationStatus)").trim()
            } catch {
                return "Failed to run pipeline: \(error.localizedDescription)"
            }
        }

        let result = await task.value
        log = result
        running = false
    }
}
