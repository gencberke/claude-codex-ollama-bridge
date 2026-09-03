import AppKit
import Combine
import Darwin
import Foundation
import SwiftUI

let maxCommandOutput = 64 * 1024
let maxLogBytes = 512 * 1024
let maxLogLines = 2_000

@main
struct CobMenuApp: App {
    @StateObject private var controller = CobController()

    var body: some Scene {
        MenuBarExtra {
            CobPopover(controller: controller)
                .frame(width: 380)
                .onAppear {
                    controller.refreshAndLoadConfig()
                    controller.loadRecentLogSummary()
                }
        } label: {
            CobMark(status: controller.statusKind)
                .frame(width: 18, height: 18)
                .help("cob")
        }
        .menuBarExtraStyle(.window)
    }
}

struct CobMark: View {
    let status: String

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(nsImage: CobTemplateIcon.image)
                .resizable()
                .renderingMode(.template)
                .foregroundStyle(.primary)
                .opacity(status == "stopped" ? 0.42 : 1)
            if status == "attention" {
                Circle()
                    .fill(.orange)
                    .frame(width: 5, height: 5)
                    .overlay(Text("!").font(.system(size: 4, weight: .bold)).foregroundStyle(.white))
            }
        }
        .frame(width: 18, height: 18)
    }
}

/// A code-drawn monochrome template image. AppKit owns menu-bar tinting, so
/// the mark stays visible in light, dark, selected, and inactive appearances.
private enum CobTemplateIcon {
    static let image: NSImage = {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.setStrokeColor(NSColor.black.cgColor)
            context.setLineWidth(1.55)
            context.setLineCap(.round)
            context.setLineJoin(.round)

            context.translateBy(x: 9, y: 8.3)
            for angle in [CGFloat.zero, .pi / 3, -.pi / 3] {
                context.saveGState()
                context.rotate(by: angle)
                context.strokeEllipse(in: CGRect(x: -5.2, y: -3.6, width: 10.4, height: 7.2))
                context.restoreGState()
            }
            context.translateBy(x: -9, y: -8.3)

            let ears = CGMutablePath()
            ears.move(to: CGPoint(x: 5.8, y: 12.1))
            ears.addLine(to: CGPoint(x: 5.2, y: 16.4))
            ears.addLine(to: CGPoint(x: 7.5, y: 14.2))
            ears.move(to: CGPoint(x: 10.6, y: 14.2))
            ears.addLine(to: CGPoint(x: 12.8, y: 16.4))
            ears.addLine(to: CGPoint(x: 12.2, y: 12.1))
            context.addPath(ears)
            context.strokePath()
            return true
        }
        image.isTemplate = true
        return image
    }()
}

struct CobPopover: View {
    @ObservedObject var controller: CobController

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                Divider()
                VStack(spacing: 0) {
                    gatewaySummary
                    Divider().padding(.horizontal, 16)
                    actionRows
                    messageRows
                    if !controller.recentLogSummary.isEmpty {
                        Divider().padding(.horizontal, 16)
                        recentLogs
                    }
                }
                Divider()
                footer
            }
        }
        .onAppear { controller.startPolling() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            CobMark(status: controller.statusKind)
                .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text("cob").font(.system(size: 15, weight: .semibold))
                HStack(spacing: 5) {
                    Circle()
                        .fill(controller.isRunning ? Color.green : Color.secondary)
                        .frame(width: 6, height: 6)
                    Text(controller.statusSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if controller.busy { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private var gatewaySummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("GATEWAY")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            HStack(spacing: 0) {
                Metric(label: "Version", value: controller.gatewayVersion)
                Metric(label: "Port", value: controller.gatewayPort)
                Metric(label: "PID", value: controller.gatewayPID)
                Metric(label: "Catalog", value: controller.catalogFreshness)
            }
            HStack {
                Button { controller.run("start") } label: { Label("Start", systemImage: "play.fill") }
                    .disabled(controller.busy || controller.isRunning)
                Button { controller.run("stop") } label: { Label("Stop", systemImage: "stop.fill") }
                    .disabled(controller.busy || !controller.isRunning)
                Spacer()
                Button { controller.run("sync") } label: { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(controller.busy)
                Button { controller.verifyState() } label: { Label("Verify", systemImage: "checkmark.shield") }
                    .disabled(controller.busy)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(16)
    }

    private var actionRows: some View {
        VStack(spacing: 0) {
            if controller.config != nil {
                NavigationLink {
                    ModelsView(controller: controller)
                } label: {
                    MenuRow(icon: "slider.horizontal.3", title: "Models", detail: "Picker visibility and order", showsChevron: true)
                }
                .buttonStyle(.plain)
                NavigationLink {
                    SettingsView(controller: controller)
                } label: {
                    MenuRow(icon: "gearshape", title: "Safe settings", detail: "Compaction and search", showsChevron: true)
                }
                .buttonStyle(.plain)
            }
            Button {
                controller.showLogWindow()
            } label: {
                MenuRow(icon: "text.alignleft", title: "Logs", detail: "Gateway and diagnostics")
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var messageRows: some View {
        if let error = controller.errorMessage {
            MessageRow(icon: "exclamationmark.triangle.fill", text: error, color: .red)
        }
        if controller.desktopRestartRequired {
            MessageRow(icon: "arrow.clockwise", text: "Fully quit and reopen ChatGPT Desktop to load the updated catalog.", color: .orange)
        }
        if let success = controller.successMessage {
            MessageRow(icon: "checkmark.circle.fill", text: success, color: .green)
        }
    }

    private var recentLogs: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("RECENT ACTIVITY")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(controller.recentLogSummary)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
    }

    private var footer: some View {
        HStack {
            if controller.canChooseCob {
                Button("Select cob executable…") { controller.selectCob() }
                    .disabled(controller.busy)
            }
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

private struct Metric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.system(size: 12, weight: .medium, design: .rounded)).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MenuRow: View {
    let icon: String
    let title: String
    let detail: String
    var showsChevron = false
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 13, weight: .medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(isHovering ? Color.primary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        .padding(.horizontal, 6)
        .onHover { isHovering = $0 }
    }
}

private struct MessageRow: View {
    let icon: String
    let text: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            Text(text).font(.caption).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(color.opacity(0.08))
    }
}

private struct ModelsView: View {
    @ObservedObject var controller: CobController

    var body: some View {
        List {
            if let config = controller.config {
                Section("Picker models") {
                    ForEach(config.catalog.models) { model in
                        HStack {
                            Image(systemName: model.kind == "ollama" ? "brain" : "sparkles").foregroundStyle(.secondary)
                            Toggle(model.slug, isOn: controller.modelVisibilityBinding(model))
                                .font(.system(.body, design: .monospaced))
                        }
                        .disabled(controller.isModelEnvironmentLocked(model))
                    }
                }
                if !controller.configuredOllamaModels.isEmpty {
                    Section("Ollama order") {
                        ForEach(controller.configuredOllamaModels) { model in
                            HStack {
                                Text(model.slug).font(.system(size: 11, design: .monospaced))
                                Spacer()
                                Button("↑") { controller.moveConfiguredOllamaModel(model.slug, by: -1) }.buttonStyle(.borderless)
                                Button("↓") { controller.moveConfiguredOllamaModel(model.slug, by: 1) }.buttonStyle(.borderless)
                            }
                            .disabled(controller.isModelEnvironmentLocked(model))
                        }
                    }
                }
                if controller.configDirty {
                    Section { Button("Apply & Sync") { controller.applyConfig() }.disabled(controller.busy) }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .listStyle(.inset)
        .navigationTitle("Models")
        .frame(height: 460)
    }
}

private struct SettingsView: View {
    @ObservedObject var controller: CobController

    var body: some View {
        List {
            Section("Safe settings") {
                Toggle("Search tool", isOn: controller.searchBinding)
                    .disabled(controller.isEnvironmentLocked("catalog.supports_search_tool"))
                Picker("Ollama compact", selection: controller.compactThreadBinding) {
                    Text("Summarize").tag("summarize")
                    Text("Native replay").tag("native")
                }.disabled(controller.isEnvironmentLocked("compaction.ollama_threads"))
                TextField("Optional compact model", text: controller.compactModelBinding)
                    .disabled(controller.isEnvironmentLocked("compaction.ollama_model"))
                Picker("Compact effort", selection: controller.compactEffortBinding) {
                    Text("Default").tag("default")
                    Text("None").tag("none")
                    Text("Low").tag("low")
                    Text("High").tag("high")
                    Text("Max").tag("max")
                }.disabled(controller.isEnvironmentLocked("compaction.ollama_effort"))
            }
            if controller.configDirty {
                Section { Button("Apply & Sync") { controller.applyConfig() }.disabled(controller.busy) }
            }
        }
        .listStyle(.inset)
        .navigationTitle("Safe settings")
        .frame(height: 360)
    }
}

struct LogWindow: View {
    @ObservedObject var controller: CobController
    @State private var query = ""
    @State private var paused = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Log", selection: $controller.logKind) {
                    Text("Gateway").tag("gateway")
                    if controller.diagnosticsAvailable {
                        Text("Diagnostics").tag("diagnostics")
                    }
                }.pickerStyle(.segmented).frame(width: 180)
                TextField("Filter", text: $query).textFieldStyle(.roundedBorder)
                Toggle("Pause", isOn: $paused).toggleStyle(.checkbox)
                Button("Reload") { controller.loadLogs() }
            }.padding(8)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(filteredText)
                            .font(.system(size: 11, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(10)
                        Color.clear.frame(height: 1).id("log-bottom")
                    }
                }
                .onChange(of: controller.logText) { _ in scrollToBottom(proxy) }
                .onAppear { scrollToBottom(proxy) }
            }
        }
        .onAppear { controller.openLogs() }
        .onDisappear { controller.stopLogWatching() }
        .onChange(of: controller.logKind) { _ in
            controller.loadLogs()
            controller.restartLogWatching()
        }
        .onChange(of: paused) { value in controller.logPaused = value }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        guard !paused else { return }
        DispatchQueue.main.async {
            proxy.scrollTo("log-bottom", anchor: .bottom)
        }
    }

    private var filteredText: String {
        guard !query.isEmpty else { return controller.logText }
        return controller.logText.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { $0.localizedCaseInsensitiveContains(query) }.joined(separator: "\n")
    }
}

@MainActor
final class CobController: ObservableObject {
    @Published var status: StatusDocument?
    @Published var config: ConfigDocument?
    @Published var busy = false
    @Published var configDirty = false
    @Published var logText = ""
    @Published var logKind = "gateway"
    @Published var recentLogSummary = ""
    @Published var errorMessage: String?
    @Published var successMessage: String?
    @Published var canChooseCob = false
    @Published var desktopRestartRequired = false
    @Published var diagnosticsAvailable = false
    var logPaused = false

    private var timer: Timer?
    private var logWatcher: DispatchSourceFileSystemObject?
    private var logDirectoryFD: Int32 = -1
    private var logFileWatcher: DispatchSourceFileSystemObject?
    private var logFileFD: Int32 = -1
    private var logReloadWorkItem: DispatchWorkItem?
    private var logWatcherNeedsRestart = false
    private var lastLogSignature: String?
    private var logLoadGeneration = 0
    private var draftSearchTool = true
    private var draftThreads = "summarize"
    private var draftOllamaModel = ""
    private var draftEffort = "default"
    private var draftModels: [String] = []
    private var draftNativeInclude: [String] = []
    private var draftNativeExclude: [String] = []
    private var cobPath = CobPathSelectionState()
    private var logWindowController: NSWindowController?

    deinit { timer?.invalidate() }

    var statusKind: String {
        guard let status else { return "attention" }
        if status.gateway.healthy && status.catalog.freshness == "fresh" { return "healthy" }
        if !status.gateway.running { return "stopped" }
        return "attention"
    }
    var statusSummary: String { status?.kind.capitalized ?? "Checking…" }
    var isRunning: Bool { status?.gateway.running == true }
    var gatewayVersion: String { status?.install.version ?? "—" }
    var gatewayPort: String { status?.gateway.port.map(String.init) ?? "—" }
    var gatewayPID: String { status?.gateway.pid.map(String.init) ?? "—" }
    var catalogFreshness: String { status?.catalog.freshness ?? "unknown" }
    var configuredOllamaModels: [ConfigDocument.ConfigCatalog.Model] {
        guard let config else { return [] }
        let bySlug = Dictionary(uniqueKeysWithValues: config.catalog.models.filter { $0.kind == "ollama" }.map { ($0.slug, $0) })
        return draftModels.compactMap { bySlug[$0] }
    }

    var searchBinding: Binding<Bool> {
        Binding(get: { self.draftSearchTool }, set: { self.draftSearchTool = $0; self.configDirty = true })
    }
    var compactThreadBinding: Binding<String> {
        Binding(get: { self.draftThreads }, set: { self.draftThreads = $0; self.configDirty = true })
    }
    var compactModelBinding: Binding<String> {
        Binding(get: { self.draftOllamaModel }, set: { self.draftOllamaModel = $0; self.configDirty = true })
    }
    var compactEffortBinding: Binding<String> {
        Binding(get: { self.draftEffort }, set: { self.draftEffort = $0; self.configDirty = true })
    }

    func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.busy else { return }
                self.refresh()
            }
        }
    }

    func refresh() {
        guard !busy else { return }
        run("status", "--json", updateStatus: true)
    }

    func verifyState() {
        run("state", "verify") { [weak self] result in
            guard result.status == 0 else { return }
            self?.successMessage = "State verified successfully."
        }
    }

    func refreshAndLoadConfig() {
        guard !busy else { return }
        run("status", "--json", updateStatus: true) { [weak self] _ in
            self?.loadConfig()
        }
    }

    func loadConfig() {
        guard !busy else { return }
        run("config", "show", "--json") { [weak self] result in
            guard let self else { return }
            guard result.status == 0 else { return }
            guard let document = try? JSONDecoder().decode(ConfigDocument.self, from: result.stdout) else {
                self.errorMessage = "Config response could not be decoded (unsupported schema)."
                return
            }
            self.config = document
            self.draftSearchTool = document.effective.catalog.supportsSearchTool
            self.draftThreads = document.effective.compaction.ollamaThreads
            self.draftOllamaModel = document.effective.compaction.ollamaModel ?? ""
            self.draftEffort = document.effective.compaction.ollamaEffort ?? "default"
            self.draftModels = document.effective.subagents.models
            self.draftNativeInclude = document.effective.catalog.nativeInclude
            self.draftNativeExclude = document.effective.catalog.nativeExclude
            self.configDirty = false
        }
    }

    func applyConfig() {
        guard !busy else { return }
        guard let config else { return }
        let compactThreadsLocked = isEnvironmentLocked("compaction.ollama_threads")
        let compactModelLocked = isEnvironmentLocked("compaction.ollama_model")
        let compactEffortLocked = isEnvironmentLocked("compaction.ollama_effort")
        let compaction: ConfigPatch.Compaction? = compactThreadsLocked && compactModelLocked && compactEffortLocked
            ? nil
            : ConfigPatch.Compaction(
                ollamaThreads: compactThreadsLocked ? nil : draftThreads,
                ollamaModel: draftOllamaModel.isEmpty ? nil : draftOllamaModel,
                ollamaEffort: draftEffort == "default" ? nil : draftEffort,
                includeOllamaModel: !compactModelLocked,
                includeOllamaEffort: !compactEffortLocked,
            )
        let models: ConfigPatch.Subagents? = isEnvironmentLocked("subagents.models")
            ? nil
            : ConfigPatch.Subagents(models: draftModels)
        let includeLocked = isEnvironmentLocked("catalog.native_include")
        let excludeLocked = isEnvironmentLocked("catalog.native_exclude")
        let searchLocked = isEnvironmentLocked("catalog.supports_search_tool")
        let catalog: ConfigPatch.Catalog? = includeLocked && excludeLocked && searchLocked
            ? nil
            : ConfigPatch.Catalog(
                nativeInclude: includeLocked ? nil : draftNativeInclude,
                nativeExclude: excludeLocked ? nil : draftNativeExclude,
                supportsSearchTool: searchLocked ? nil : draftSearchTool,
            )
        let patch = ConfigPatch(schemaVersion: 1, expectedRevision: config.configRevision,
                                compaction: compaction,
                                subagents: models,
                                catalog: catalog)
        guard let data = try? JSONEncoder().encode(patch) else { return }
        run("config", "apply", "--json", stdin: data) { [weak self] result in
            guard let self else { return }
            guard result.status == 0 else { return }
            guard let updated = try? JSONDecoder().decode(ConfigDocument.self, from: result.stdout) else {
                self.errorMessage = "Config apply failed or returned a stale revision; reload and try again."
                return
            }
            self.config = updated
            self.configDirty = false
            if let object = try? JSONSerialization.jsonObject(with: result.stdout) as? [String: Any],
               object["desktop_restart_required"] as? Bool == true {
                self.desktopRestartRequired = true
            }
            self.refresh()
        }
    }

    func modelVisibilityBinding(_ model: ConfigDocument.ConfigCatalog.Model) -> Binding<Bool> {
        Binding(
            get: { self.isModelVisible(model) },
            set: { self.setModelVisible(model, visible: $0) },
        )
    }

    func moveConfiguredOllamaModel(_ slug: String, by offset: Int) {
        let ollamaSlugs = Set(config?.catalog.models.filter { $0.kind == "ollama" }.map(\.slug) ?? [])
        var state = ModelDraftState(models: draftModels, ollamaSlugs: ollamaSlugs)
        state.moveOllama(slug, by: offset)
        draftModels = state.models
        configDirty = true
    }

    func isEnvironmentLocked(_ field: String) -> Bool {
        guard let sources = config?.sources else { return false }
        let components = field.split(separator: ".", maxSplits: 1).map(String.init)
        guard components.count == 2 else { return false }
        let source: String?
        switch components[0] {
        case "compaction": source = sources.compaction[components[1]]
        case "subagents": source = sources.subagents[components[1]]
        case "catalog": source = sources.catalog[components[1]]
        default: source = nil
        }
        return source == "environment"
    }

    func isModelEnvironmentLocked(_ model: ConfigDocument.ConfigCatalog.Model) -> Bool {
        model.kind == "ollama"
            ? isEnvironmentLocked("subagents.models")
            : isEnvironmentLocked("catalog.native_include") || isEnvironmentLocked("catalog.native_exclude")
    }

    private func isModelVisible(_ model: ConfigDocument.ConfigCatalog.Model) -> Bool {
        if model.kind == "ollama" { return draftModels.contains(model.slug) }
        if draftNativeExclude.contains(model.slug) { return false }
        if draftNativeInclude.contains(model.slug) { return true }
        return model.visibility == "list"
    }

    private func setModelVisible(_ model: ConfigDocument.ConfigCatalog.Model, visible: Bool) {
        if model.kind == "ollama" {
            if visible, !draftModels.contains(model.slug) { draftModels.append(model.slug) }
            if !visible { draftModels.removeAll { $0 == model.slug } }
        } else {
            draftNativeInclude.removeAll { $0 == model.slug }
            draftNativeExclude.removeAll { $0 == model.slug }
            if visible && model.visibility != "list" { draftNativeInclude.append(model.slug) }
            if !visible && model.visibility == "list" { draftNativeExclude.append(model.slug) }
        }
        configDirty = true
    }

    func run(_ arguments: String..., stdin: Data? = nil, updateStatus: Bool = false, completion: ((CobProcess.Result) -> Void)? = nil) {
        guard !busy else { return }
        if arguments.first != "status" { successMessage = nil }
        busy = true
        resolveCobPath { [weak self] path in
            guard let self else { return }
            DispatchQueue.global(qos: .utility).async {
                let version = CobProcess.run(path: path, arguments: ["version"], stdin: nil)
                let versionText = String(decoding: version.stdout, as: UTF8.self)
                let validVersion = version.status == 0 && versionText.hasPrefix("cob ")
                let result = validVersion
                    ? CobProcess.run(path: path, arguments: arguments, stdin: stdin)
                    : CobProcess.Result(status: 1, stdout: Data(), stderr: Data())
                DispatchQueue.main.async {
                    self.busy = false
                    if !validVersion {
                        self.invalidateCachedCobPath(path)
                        self.canChooseCob = true
                        self.errorMessage = "Selected cob executable failed version validation."
                    } else if result.status != 0 {
                        let detail = String(decoding: result.stderr.prefix(300), as: UTF8.self)
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        self.errorMessage = detail.isEmpty ? "cob command failed (status \(result.status))." : detail
                    } else if updateStatus {
                        do {
                            self.status = try JSONDecoder().decode(StatusDocument.self, from: result.stdout)
                            self.errorMessage = nil
                        } catch {
                            self.status = nil
                            self.errorMessage = "Status response could not be decoded (unsupported schema)."
                        }
                    } else if result.status == 0 {
                        self.errorMessage = nil
                    }
                    completion?(result)
                    if arguments.first != "status" && arguments.first != "config" { self.refresh() }
                }
            }
        }
    }

    func openLogs() {
        loadLogs()
        startLogWatching()
    }

    func showLogWindow() {
        openLogs()
        if logWindowController == nil {
            let content = LogWindow(controller: self)
                .frame(minWidth: 560, minHeight: 320)
            let window = NSWindow(contentViewController: NSHostingController(rootView: content))
            window.title = "cob Logs"
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.setContentSize(NSSize(width: 760, height: 460))
            window.minSize = NSSize(width: 560, height: 320)
            window.isReleasedWhenClosed = false
            window.center()
            logWindowController = NSWindowController(window: window)
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
        logWindowController?.showWindow(nil)
        logWindowController?.window?.makeKeyAndOrderFront(nil)
    }

    func loadLogs(force: Bool = false) {
        guard !logPaused else { return }
        refreshDiagnosticAvailability()
        let path = currentLogPath()
        let archive = "\(path.path).1"
        let signature = BoundedLog.signature(current: path.path, archive: archive)
        guard force || signature != lastLogSignature else { return }
        lastLogSignature = signature
        logLoadGeneration += 1
        let generation = logLoadGeneration
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let text = BoundedLog.read(current: path.path, archive: archive)
            let summary = text.split(separator: "\n", omittingEmptySubsequences: true)
                .suffix(3)
                .joined(separator: "\n")
            DispatchQueue.main.async {
                guard let self, generation == self.logLoadGeneration, !self.logPaused else { return }
                self.logText = text
                self.recentLogSummary = summary
            }
        }
    }

    private func refreshDiagnosticAvailability() {
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
        let diagnosticPath = home.appendingPathComponent("cob-diagnostics.jsonl")
        diagnosticsAvailable = FileManager.default.fileExists(atPath: diagnosticPath.path)
        if !diagnosticsAvailable && logKind == "diagnostics" {
            logKind = "gateway"
        }
    }

    private func currentLogPath() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
        return logKind == "diagnostics" ? home.appendingPathComponent("cob-diagnostics.jsonl") : home.appendingPathComponent("cob-gateway.log")
    }

    func loadRecentLogSummary() {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/cob-gateway.log")
        recentLogSummary = BoundedLog.summary(current: path.path, archive: "\(path.path).1")
    }

    func startLogWatching() {
        stopLogWatching()
        startFileWatcher()
        if logFileWatcher == nil { startDirectoryFallbackWatcher() }
    }

    private func startDirectoryFallbackWatcher() {
        guard logWatcher == nil else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
        let fd = Darwin.open(home.path, O_EVTONLY)
        guard fd >= 0 else { return }
        logDirectoryFD = fd
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: DispatchQueue.global(qos: .utility),
        )
        source.setEventHandler { [weak self] in
            Task { @MainActor in
                guard let self, !self.logPaused else { return }
                self.scheduleLogReload(restartWatcher: true)
            }
        }
        source.setCancelHandler { close(fd) }
        logWatcher = source
        source.resume()
    }

    func restartLogWatching() {
        lastLogSignature = nil
        startLogWatching()
    }

    private func startFileWatcher() {
        let path = currentLogPath()
        let fd = Darwin.open(path.path, O_EVTONLY)
        guard fd >= 0 else { return }
        logFileFD = fd
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .attrib, .rename, .delete],
            queue: DispatchQueue.global(qos: .utility),
        )
        source.setEventHandler { [weak self, source] in
            let flags = source.data
            Task { @MainActor in
                guard let self, !self.logPaused else { return }
                self.scheduleLogReload(restartWatcher: flags.contains(.rename) || flags.contains(.delete))
            }
        }
        source.setCancelHandler { close(fd) }
        logFileWatcher = source
        source.resume()
        logWatcher?.cancel()
        logWatcher = nil
        logDirectoryFD = -1
    }

    private func scheduleLogReload(restartWatcher: Bool) {
        logWatcherNeedsRestart = logWatcherNeedsRestart || restartWatcher
        logReloadWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, !self.logPaused else { return }
                if self.logWatcherNeedsRestart {
                    self.logWatcherNeedsRestart = false
                    self.logFileWatcher?.cancel()
                    self.logFileWatcher = nil
                    self.logFileFD = -1
                    self.startFileWatcher()
                    if self.logFileWatcher == nil { self.startDirectoryFallbackWatcher() }
                }
                self.loadLogs()
            }
        }
        logReloadWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(350), execute: item)
    }

    func stopLogWatching() {
        logReloadWorkItem?.cancel()
        logReloadWorkItem = nil
        logWatcherNeedsRestart = false
        logWatcher?.cancel()
        logWatcher = nil
        logDirectoryFD = -1
        logFileWatcher?.cancel()
        logFileWatcher = nil
        logFileFD = -1
    }

    func selectCob() {
        resolveCobPath(prompt: true) { [weak self] _ in
            self?.canChooseCob = false
            self?.errorMessage = nil
        }
    }

    private func resolveCobPath(prompt: Bool = false, completion: @escaping (String) -> Void) {
        if !prompt, let cachedPath = cobPath.cachedPath,
           FileManager.default.isExecutableFile(atPath: cachedPath) {
            completion(cachedPath)
            return
        }
        if prompt {
            presentCobChooser(completion: completion)
            return
        }
        let defaults = UserDefaults.standard
        var candidates: [String] = []
        if let saved = defaults.string(forKey: "cob.cliPath") { candidates.append(saved) }
        let runtime = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/cob-runtime.json")
        let runtimeData: Data? = {
            guard let handle = try? FileHandle(forReadingFrom: runtime) else { return nil }
            defer { try? handle.close() }
            return try? handle.read(upToCount: maxCommandOutput)
        }()
        if let data = runtimeData,
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = value["cliPath"] as? String {
            candidates.append(path)
        }
        candidates += ["/opt/homebrew/bin/cob", "/usr/local/bin/cob"]
        if let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            cobPath.cachedPath = path
            completion(path)
            return
        }
        canChooseCob = true
        errorMessage = "cob executable not found. Select it to connect the panel."
        busy = false
    }

    private func presentCobChooser(completion: @escaping (String) -> Void) {
        let defaults = UserDefaults.standard
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            panel.message = "Select the cob executable"
            if panel.runModal() == .OK, let url = panel.url, FileManager.default.isExecutableFile(atPath: url.path) {
                defaults.set(url.path, forKey: "cob.cliPath")
                self.cobPath.cachedPath = url.path
                completion(url.path)
            } else { self.busy = false; self.errorMessage = "No cob executable selected." }
        }
    }

    private func invalidateCachedCobPath(_ path: String) {
        cobPath.clearIf(path)
        let defaults = UserDefaults.standard
        if defaults.string(forKey: "cob.cliPath") == path {
            defaults.removeObject(forKey: "cob.cliPath")
        }
    }
}

enum CobProcess {
    struct Result { let status: Int32; let stdout: Data; let stderr: Data }

    static func run(path: String, arguments: [String], stdin: Data?) -> Result {
        let process = Process(); process.executableURL = URL(fileURLWithPath: path); process.arguments = arguments
        let output = Pipe(); let errors = Pipe()
        process.standardOutput = output; process.standardError = errors
        let input: Pipe?
        if stdin != nil {
            let pipe = Pipe()
            input = pipe
            process.standardInput = pipe
        } else {
            input = nil
            process.standardInput = FileHandle.nullDevice
        }
        do {
            try process.run()
        } catch {
            return Result(status: 1, stdout: Data(), stderr: Data())
        }
        let outputReader = output.fileHandleForReading
        let errorReader = errors.fileHandleForReading
        let outputGroup = DispatchGroup(); let errorGroup = DispatchGroup()
        var capturedOutput = Data(); var capturedErrors = Data()
        outputGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { outputGroup.leave() }
            while let chunk = try? outputReader.read(upToCount: 4 * 1024) {
                if chunk.isEmpty { break }
                if capturedOutput.count < maxCommandOutput { capturedOutput.append(chunk.prefix(maxCommandOutput - capturedOutput.count)) }
            }
        }
        errorGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { errorGroup.leave() }
            while let chunk = try? errorReader.read(upToCount: 4 * 1024) {
                if chunk.isEmpty { break }
                if capturedErrors.count < maxCommandOutput { capturedErrors.append(chunk.prefix(maxCommandOutput - capturedErrors.count)) }
            }
        }
        if let stdin {
            do {
                try input?.fileHandleForWriting.write(contentsOf: stdin)
                try input?.fileHandleForWriting.close()
            } catch {
                try? input?.fileHandleForWriting.close()
            }
        }
        process.waitUntilExit()
        outputGroup.wait(); errorGroup.wait()
        return Result(status: process.terminationStatus, stdout: capturedOutput, stderr: capturedErrors)
    }
}

enum BoundedLog {
    static func signature(current: String, archive: String) -> String {
        [current, archive].map(fileSignature).joined(separator: "|")
    }

    static func read(current: String, archive: String) -> String {
        // Read only tails from newest to oldest. The viewer never loads an
        // unbounded file, and the archive cannot displace a newer active tail.
        var chunks: [Data] = []
        var remaining = maxLogBytes
        for file in [current, archive] {
            guard remaining > 0, let tail = boundedTail(path: file, limit: remaining), !tail.isEmpty else { continue }
            chunks.append(tail)
            remaining -= tail.count
        }
        var data = Data()
        for chunk in chunks.reversed() { data.append(chunk) }
        let lines = String(decoding: data, as: UTF8.self)
            .split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(maxLogLines).joined(separator: "\n")
    }

    static func summary(current: String, archive: String) -> String {
        read(current: current, archive: archive)
            .split(separator: "\n", omittingEmptySubsequences: true)
            .suffix(3)
            .joined(separator: "\n")
    }

    private static func boundedTail(path: String, limit: Int) -> Data? {
        guard limit > 0 else { return Data() }
        do {
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
            defer { try? handle.close() }
            let end = try handle.seekToEnd()
            let start = end > UInt64(limit) ? end - UInt64(limit) : 0
            try handle.seek(toOffset: start)
            return try handle.read(upToCount: limit) ?? Data()
        } catch {
            return nil
        }
    }

    private static func fileSignature(path: String) -> String {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return "missing" }
        let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        let size = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        return "\(inode):\(size):\(modified)"
    }
}

struct StatusDocument: Decodable {
    let schemaVersion: Int
    let kind: String
    let install: Install
    let gateway: Gateway
    let catalog: Catalog
    enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", kind, install, gateway, catalog }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .schemaVersion, in: container, debugDescription: "unsupported status schema_version")
        }
        self.schemaVersion = schemaVersion
        self.kind = try container.decode(String.self, forKey: .kind)
        self.install = try container.decode(Install.self, forKey: .install)
        self.gateway = try container.decode(Gateway.self, forKey: .gateway)
        self.catalog = try container.decode(Catalog.self, forKey: .catalog)
    }
    struct Install: Decodable { let version: String }
    struct Gateway: Decodable { let running: Bool; let healthy: Bool; let port: Int?; let pid: Int? }
    struct Catalog: Decodable { let freshness: String }
}

struct ConfigDocument: Decodable {
    let schemaVersion: Int
    let configRevision: String?
    let effective: Effective
    let sources: Sources
    let catalog: ConfigCatalog
    enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", configRevision = "config_revision", effective, sources, catalog }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .schemaVersion, in: container, debugDescription: "unsupported config schema_version")
        }
        self.schemaVersion = schemaVersion
        self.configRevision = try container.decodeIfPresent(String.self, forKey: .configRevision)
        self.effective = try container.decode(Effective.self, forKey: .effective)
        self.sources = try container.decode(Sources.self, forKey: .sources)
        self.catalog = try container.decode(ConfigCatalog.self, forKey: .catalog)
    }
    struct Effective: Decodable { let compaction: Compaction; let subagents: Subagents; let catalog: SafeCatalog }
    struct Compaction: Decodable {
        let provider: String
        let model: String?
        let ollamaThreads: String
        let ollamaModel: String?
        let ollamaEffort: String?
        enum CodingKeys: String, CodingKey {
            case provider, model, ollamaThreads = "ollama_threads", ollamaModel = "ollama_model", ollamaEffort = "ollama_effort"
        }
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "native"
            model = try container.decodeIfPresent(String.self, forKey: .model)
            ollamaThreads = try container.decodeIfPresent(String.self, forKey: .ollamaThreads) ?? "summarize"
            ollamaModel = try container.decodeIfPresent(String.self, forKey: .ollamaModel)
            ollamaEffort = try container.decodeIfPresent(String.self, forKey: .ollamaEffort)
        }
    }
    struct Subagents: Decodable { let models: [String] }
    struct SafeCatalog: Decodable {
        let nativeInclude: [String]
        let nativeExclude: [String]
        let supportsSearchTool: Bool
        enum CodingKeys: String, CodingKey {
            case nativeInclude = "native_include", nativeExclude = "native_exclude", supportsSearchTool = "supports_search_tool"
        }
    }
    struct ConfigCatalog: Decodable {
        let models: [Model]
        struct Model: Decodable, Identifiable {
            let slug: String; let kind: String; let visibility: String
            var id: String { slug }
        }
    }
    struct Sources: Decodable {
        let compaction: [String: String]
        let subagents: [String: String]
        let catalog: [String: String]
    }
}

struct ConfigPatch: Encodable {
    let schemaVersion: Int
    let expectedRevision: String?
    let compaction: Compaction?
    let subagents: Subagents?
    let catalog: Catalog?
    enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", expectedRevision = "expected_revision", compaction, subagents, catalog }
    struct Compaction: Encodable {
        let ollamaThreads: String?
        let ollamaModel: String?
        let ollamaEffort: String?
        let includeOllamaModel: Bool
        let includeOllamaEffort: Bool
        enum CodingKeys: String, CodingKey { case ollamaThreads = "ollama_threads", ollamaModel = "ollama_model", ollamaEffort = "ollama_effort" }
        init(
            ollamaThreads: String?,
            ollamaModel: String?,
            ollamaEffort: String?,
            includeOllamaModel: Bool = true,
            includeOllamaEffort: Bool = true,
        ) {
            self.ollamaThreads = ollamaThreads
            self.ollamaModel = ollamaModel
            self.ollamaEffort = ollamaEffort
            self.includeOllamaModel = includeOllamaModel
            self.includeOllamaEffort = includeOllamaEffort
        }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(ollamaThreads, forKey: .ollamaThreads)
            // Null is intentional: clearing the optional setting is a safe,
            // versioned operation and must not be confused with omission.
            if includeOllamaModel { try container.encode(ollamaModel, forKey: .ollamaModel) }
            if includeOllamaEffort { try container.encode(ollamaEffort, forKey: .ollamaEffort) }
        }
    }
    struct Subagents: Encodable {
        let models: [String]?
        enum CodingKeys: String, CodingKey { case models }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(models, forKey: .models)
        }
    }
    struct Catalog: Encodable {
        let nativeInclude: [String]?
        let nativeExclude: [String]?
        let supportsSearchTool: Bool?
        enum CodingKeys: String, CodingKey {
            case nativeInclude = "native_include", nativeExclude = "native_exclude", supportsSearchTool = "supports_search_tool"
        }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(nativeInclude, forKey: .nativeInclude)
            try container.encodeIfPresent(nativeExclude, forKey: .nativeExclude)
            try container.encodeIfPresent(supportsSearchTool, forKey: .supportsSearchTool)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(expectedRevision, forKey: .expectedRevision)
        try container.encodeIfPresent(compaction, forKey: .compaction)
        try container.encodeIfPresent(subagents, forKey: .subagents)
        try container.encodeIfPresent(catalog, forKey: .catalog)
    }
}

struct ModelDraftState {
    var models: [String]
    let ollamaSlugs: Set<String>

    mutating func moveOllama(_ slug: String, by offset: Int) {
        guard let current = models.firstIndex(of: slug) else { return }
        let ollamaIndices = models.indices.filter { ollamaSlugs.contains(models[$0]) }
        guard let position = ollamaIndices.firstIndex(of: current) else { return }
        let destinationPosition = position + offset
        guard ollamaIndices.indices.contains(destinationPosition) else { return }
        models.swapAt(current, ollamaIndices[destinationPosition])
    }
}

struct CobPathSelectionState {
    var cachedPath: String?

    mutating func clearIf(_ invalidPath: String) {
        if cachedPath == invalidPath { cachedPath = nil }
    }
}
