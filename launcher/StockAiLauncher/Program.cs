using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StockAiLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new LauncherForm());
    }
}

internal static class AppInfo
{
    internal const string LocalVersion = "1.0.0";
    internal const string DefaultRepository = "tomwu/stock_ai";
}

internal sealed class LauncherForm : Form
{
    private readonly TextBox repositoryTextBox = new();
    private readonly CheckBox autoUpdateCheckBox = new();
    private readonly Label statusLabel = new();
    private readonly Label versionLabel = new();
    private readonly Button launchButton = new();
    private readonly Button refreshButton = new();
    private readonly Button openAppButton = new();
    private readonly Button openReleaseButton = new();
    private readonly Button saveButton = new();

    private LauncherSettings settings = LauncherSettingsStore.Load();

    public LauncherForm()
    {
        settings = LauncherSettingsStore.LoadFromSharedConfig(settings);
        Text = "Stock AI Launcher";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(900, 520);
        Size = new Size(980, 620);
        Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
        BackColor = Color.FromArgb(15, 23, 42);
        ForeColor = Color.White;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(20),
            ColumnCount = 1,
            RowCount = 5,
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 80));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 140));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(BuildSettingsPanel(), 0, 1);
        root.Controls.Add(BuildStatusPanel(), 0, 2);
        root.Controls.Add(BuildActionPanel(), 0, 3);
        root.Controls.Add(BuildFooter(), 0, 4);
        Controls.Add(root);

        Shown += async (_, _) => await RefreshStateAsync();
    }

    private Control BuildHeader()
    {
        var panel = new Panel { Dock = DockStyle.Fill };

        var title = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            Font = new Font("Segoe UI", 20F, FontStyle.Bold, GraphicsUnit.Point),
            Text = "Stock AI",
        };

        var subtitle = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ForeColor = Color.FromArgb(203, 213, 225),
            Text = "Launch Docker, check the latest GitHub release, and start the app stack.",
        };

        var version = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Bottom,
            ForeColor = Color.FromArgb(148, 163, 184),
            Text = $"Launcher version: {AppInfo.LocalVersion}",
        };

        panel.Controls.Add(version);
        panel.Controls.Add(subtitle);
        panel.Controls.Add(title);
        return panel;
    }

    private Control BuildSettingsPanel()
    {
        var group = new GroupBox
        {
            Dock = DockStyle.Fill,
            Text = "Update settings",
            ForeColor = Color.White,
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 3,
            Padding = new Padding(12),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));

        repositoryTextBox.Dock = DockStyle.Fill;
        repositoryTextBox.Text = settings.GitHubRepository;
        repositoryTextBox.BackColor = Color.FromArgb(30, 41, 59);
        repositoryTextBox.ForeColor = Color.White;

        autoUpdateCheckBox.AutoSize = true;
        autoUpdateCheckBox.Text = "Automatically download and run the latest release when versions differ";
        autoUpdateCheckBox.Checked = settings.AutoUpdate;
        autoUpdateCheckBox.Dock = DockStyle.Fill;

        layout.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "GitHub repo",
            TextAlign = ContentAlignment.MiddleLeft,
            Dock = DockStyle.Fill,
            ForeColor = Color.White,
        }, 0, 0);
        layout.Controls.Add(repositoryTextBox, 1, 0);
        layout.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "Update mode",
            TextAlign = ContentAlignment.MiddleLeft,
            Dock = DockStyle.Fill,
            ForeColor = Color.White,
        }, 0, 1);
        layout.Controls.Add(autoUpdateCheckBox, 1, 1);

        var hint = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ForeColor = Color.FromArgb(203, 213, 225),
            Text = "Manual mode keeps launching even if a newer GitHub release exists.",
        };
        layout.SetColumnSpan(hint, 2);
        layout.Controls.Add(hint, 0, 2);

        group.Controls.Add(layout);
        return group;
    }

    private Control BuildStatusPanel()
    {
        var panel = new Panel { Dock = DockStyle.Fill };

        versionLabel.AutoSize = true;
        versionLabel.Dock = DockStyle.Top;
        versionLabel.ForeColor = Color.FromArgb(226, 232, 240);
        versionLabel.Text = "Version status: checking…";

        statusLabel.AutoSize = true;
        statusLabel.Dock = DockStyle.Bottom;
        statusLabel.ForeColor = Color.FromArgb(148, 163, 184);
        statusLabel.Text = "Docker status: waiting…";

        panel.Controls.Add(statusLabel);
        panel.Controls.Add(versionLabel);
        return panel;
    }

    private Control BuildActionPanel()
    {
        var panel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            AutoScroll = true,
            Padding = new Padding(0, 8, 0, 0),
        };

        StyleButton(launchButton, "Launch stack");
        launchButton.Click += async (_, _) => await LaunchStackAsync();

        StyleButton(refreshButton, "Check updates");
        refreshButton.Click += async (_, _) => await RefreshStateAsync();

        StyleButton(openAppButton, "Open app", isPrimaryCallToAction: true);
        openAppButton.Click += (_, _) => OpenApp();

        StyleButton(openReleaseButton, "Open release page");
        openReleaseButton.Click += (_, _) => OpenReleasePage();

        StyleButton(saveButton, "Save settings");
        saveButton.Click += (_, _) => SaveSettings();

        panel.Controls.AddRange([launchButton, refreshButton, openAppButton, openReleaseButton, saveButton]);
        return panel;
    }

    private Control BuildFooter()
    {
        return new Label
        {
            Dock = DockStyle.Fill,
            AutoSize = false,
            ForeColor = Color.FromArgb(148, 163, 184),
            Text = "If Docker Desktop is not running, the launcher will try to start it before issuing docker compose up.",
        };
    }

    private static void StyleButton(Button button, string text, bool isPrimaryCallToAction = false)
    {
        button.Text = text;
        button.AutoSize = true;
        button.Padding = isPrimaryCallToAction ? new Padding(18, 10, 18, 10) : new Padding(12, 8, 12, 8);
        button.BackColor = isPrimaryCallToAction ? Color.FromArgb(22, 163, 74) : Color.FromArgb(37, 99, 235);
        button.ForeColor = Color.White;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.Font = isPrimaryCallToAction
            ? new Font("Segoe UI", 10F, FontStyle.Bold, GraphicsUnit.Point)
            : new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
        button.Margin = new Padding(0, 0, 10, 0);
    }

    private async Task RefreshStateAsync()
    {
        SaveSettings();
        await CheckVersionAsync();
        await CheckDockerAsync();
    }

    private void SaveSettings()
    {
        settings.GitHubRepository = string.IsNullOrWhiteSpace(repositoryTextBox.Text)
            ? AppInfo.DefaultRepository
            : repositoryTextBox.Text.Trim();
        settings.AutoUpdate = autoUpdateCheckBox.Checked;
        LauncherSettingsStore.Save(settings);
    }

    private async Task CheckVersionAsync()
    {
        try
        {
            var latest = await GitHubReleaseService.GetLatestReleaseAsync(settings.GitHubRepository);
            if (latest is null)
            {
                versionLabel.Text = $"Version status: unable to query latest release for {settings.GitHubRepository}";
                return;
            }

            var local = VersionTools.Normalize(AppInfo.LocalVersion);
            var remote = VersionTools.Normalize(latest.TagName);
            var mismatch = !VersionTools.Equals(local, remote);

            versionLabel.Text = mismatch
                ? $"Version status: local {local} differs from GitHub {remote}"
                : $"Version status: local {local} matches GitHub {remote}";

            if (mismatch && settings.AutoUpdate)
            {
                await RunAutoUpdateAsync(latest);
            }
        }
        catch (Exception ex)
        {
            versionLabel.Text = $"Version status: check failed ({ex.Message})";
        }
    }

    private async Task CheckDockerAsync()
    {
        try
        {
            var docker = DockerRuntime.LocateDockerCli();
            if (docker is null)
            {
                statusLabel.Text = "Docker status: Docker CLI not found";
                return;
            }

            var ok = await DockerRuntime.CanRunAsync(docker);
            statusLabel.Text = ok
                ? $"Docker status: ready ({docker.DisplayPath})"
                : "Docker status: Docker Desktop is not ready yet";
        }
        catch (Exception ex)
        {
            statusLabel.Text = $"Docker status: check failed ({ex.Message})";
        }
    }

    private async Task LaunchStackAsync()
    {
        SaveSettings();

        launchButton.Enabled = false;
        try
        {
            if (await DockerRuntime.IsHttpReachableAsync("http://localhost:3000"))
            {
                statusLabel.Text = "Docker status: site already running";
                OpenApp();
                return;
            }

            var docker = DockerRuntime.LocateDockerCli();
            if (docker is null)
            {
                MessageBox.Show(this, "Docker CLI was not found. Install Docker Desktop first.", "Stock AI", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            await DockerRuntime.EnsureReadyAsync(docker, status => statusLabel.Text = status);

            var conflicts = await DockerRuntime.FindPortConflictsAsync(docker, [3000]);
            if (conflicts.Count > 0)
            {
                var conflictText = string.Join(Environment.NewLine, conflicts.Select(c => $"- Port {c.HostPort} in use by container '{c.ContainerName}'"));
                MessageBox.Show(
                    this,
                    $"Cannot launch stack because required port mappings are already in use:{Environment.NewLine}{Environment.NewLine}{conflictText}",
                    "Stock AI launch blocked",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            var launcherFolder = Path.GetDirectoryName(Application.ExecutablePath) ?? AppContext.BaseDirectory;
            var composeFile = Path.GetFullPath(Path.Combine(launcherFolder, "..", "docker-compose.yml"));
            if (!File.Exists(composeFile))
            {
                MessageBox.Show(this, $"Could not find docker-compose.yml next to the launcher at {composeFile}.", "Stock AI", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            statusLabel.Text = "Docker status: starting stack…";
            var result = await DockerRuntime.RunAsync(docker, "compose up -d --build", Path.GetDirectoryName(composeFile)!, Path.GetDirectoryName(composeFile)!);
            if (!result.Success)
            {
                var compactError = DockerRuntime.ExtractErrorSummary(result.Output);
                MessageBox.Show(this, compactError, "Stock AI launch failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            statusLabel.Text = "Docker status: waiting for web app…";
            var ready = await DockerRuntime.WaitForHttpAsync("http://localhost:3000", status => statusLabel.Text = status);
            if (!ready)
            {
                MessageBox.Show(this, "The containers started, but the web app did not become ready on http://localhost:3000 in time.", "Stock AI launch warning", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            statusLabel.Text = "Docker status: stack started";
            OpenApp();
        }
        finally
        {
            launchButton.Enabled = true;
        }
    }

    private async Task RunAutoUpdateAsync(GitHubRelease release)
    {
        if (string.IsNullOrWhiteSpace(release.AssetDownloadUrl))
        {
            OpenReleasePage(release.HtmlUrl);
            return;
        }

        var tempFileName = Path.GetFileName(new Uri(release.AssetDownloadUrl).AbsolutePath);
        var tempFile = Path.Combine(Path.GetTempPath(), tempFileName);

        statusLabel.Text = $"Version status: downloading {release.TagName}...";
        using var http = new HttpClient();
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("StockAiLauncher", AppInfo.LocalVersion));
        await using (var stream = await http.GetStreamAsync(release.AssetDownloadUrl))
        await using (var fileStream = File.Create(tempFile))
        {
            await stream.CopyToAsync(fileStream);
        }

        statusLabel.Text = $"Version status: launching update {release.TagName}...";
        Process.Start(new ProcessStartInfo(tempFile) { UseShellExecute = true });
        Close();
    }

    private void OpenApp()
    {
        Process.Start(new ProcessStartInfo("http://localhost:3000") { UseShellExecute = true });
    }

    private void OpenReleasePage(string? releaseUrl = null)
    {
        var url = releaseUrl ?? $"https://github.com/{settings.GitHubRepository}/releases/latest";
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}

internal sealed class LauncherSettings
{
    public string GitHubRepository { get; set; } = AppInfo.DefaultRepository;

    public bool AutoUpdate { get; set; }
}

internal static class LauncherSettingsStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static LauncherSettings Load()
    {
        try
        {
            var path = GetSettingsPath();
            if (!File.Exists(path))
            {
                return new LauncherSettings();
            }

            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<LauncherSettings>(json, Options) ?? new LauncherSettings();
        }
        catch
        {
            return new LauncherSettings();
        }
    }

    public static LauncherSettings LoadFromSharedConfig(LauncherSettings current)
    {
        try
        {
            var sharedEnvPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", ".env"));
            if (!File.Exists(sharedEnvPath))
            {
                return current;
            }

            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in File.ReadAllLines(sharedEnvPath))
            {
                var trimmed = line.Trim();
                if (string.IsNullOrWhiteSpace(trimmed) || trimmed.StartsWith('#') || !trimmed.Contains('='))
                {
                    continue;
                }

                var key = trimmed.Split('=', 2)[0].Trim();
                var val = trimmed.Split('=', 2)[1].Trim();
                env[key] = val;
            }

            var next = new LauncherSettings
            {
                GitHubRepository = current.GitHubRepository,
                AutoUpdate = current.AutoUpdate,
            };

            if (env.TryGetValue("AUTO_UPDATE", out var autoUpdateValue))
            {
                next.AutoUpdate = autoUpdateValue.Equals("true", StringComparison.OrdinalIgnoreCase)
                    || autoUpdateValue.Equals("1", StringComparison.OrdinalIgnoreCase)
                    || autoUpdateValue.Equals("yes", StringComparison.OrdinalIgnoreCase)
                    || autoUpdateValue.Equals("on", StringComparison.OrdinalIgnoreCase);
            }

            return next;
        }
        catch
        {
            return current;
        }
    }

    public static void Save(LauncherSettings settings)
    {
        var path = GetSettingsPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var json = JsonSerializer.Serialize(settings, Options);
        File.WriteAllText(path, json);
    }

    private static string GetSettingsPath()
    {
        var baseFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Stock AI");
        return Path.Combine(baseFolder, "launcher-settings.json");
    }
}

internal static class VersionTools
{
    public static string Normalize(string value)
    {
        return value.Trim().TrimStart('v', 'V');
    }

    public static bool Equals(string left, string right)
    {
        return string.Equals(Normalize(left), Normalize(right), StringComparison.OrdinalIgnoreCase);
    }
}

internal sealed record GitHubRelease(string TagName, string HtmlUrl, string? AssetDownloadUrl);

internal static class GitHubReleaseService
{
    private static readonly HttpClient Http = new();
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public static async Task<GitHubRelease?> GetLatestReleaseAsync(string repository)
    {
        if (string.IsNullOrWhiteSpace(repository) || !repository.Contains('/'))
        {
            return null;
        }

        var url = $"https://api.github.com/repos/{repository.Trim()}/releases/latest";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("StockAiLauncher", AppInfo.LocalVersion));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));

        using var response = await Http.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        var payload = await JsonSerializer.DeserializeAsync<GitHubReleasePayload>(stream, JsonOptions);
        if (payload is null)
        {
            return null;
        }

        var asset = payload.Assets?.FirstOrDefault(a => a.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || a.Name.EndsWith(".msi", StringComparison.OrdinalIgnoreCase));
        return new GitHubRelease(payload.TagName ?? string.Empty, payload.HtmlUrl ?? string.Empty, asset?.BrowserDownloadUrl);
    }

    private sealed record GitHubReleasePayload(
        [property: JsonPropertyName("tag_name")] string? TagName,
        [property: JsonPropertyName("html_url")] string? HtmlUrl,
        [property: JsonPropertyName("assets")] GitHubReleaseAsset[]? Assets);

    private sealed record GitHubReleaseAsset(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("browser_download_url")] string BrowserDownloadUrl);
}

internal sealed record DockerCli(string DisplayPath, string FullPath);

internal sealed record ProcessRunResult(bool Success, string Output);

internal sealed record PortConflict(string ContainerName, int HostPort);

internal static class DockerRuntime
{
    private static readonly string[] DockerCliCandidates =
    [
        "docker",
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Docker", "Docker", "resources", "bin", "docker.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Docker", "Docker", "resources", "bin", "docker.exe"),
    ];

    private static readonly string[] DockerDesktopCandidates =
    [
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Docker", "Docker", "Docker Desktop.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Docker", "Docker", "Docker Desktop.exe"),
    ];

    public static DockerCli? LocateDockerCli()
    {
        foreach (var candidate in DockerCliCandidates)
        {
            if (candidate.Equals("docker", StringComparison.OrdinalIgnoreCase))
            {
                return new DockerCli("docker", "docker");
            }

            if (File.Exists(candidate))
            {
                return new DockerCli(candidate, candidate);
            }
        }

        return null;
    }

    public static async Task<bool> CanRunAsync(DockerCli docker)
    {
        var result = await RunAsync(docker, "version", Directory.GetCurrentDirectory(), Directory.GetCurrentDirectory(), timeoutMs: 15_000);
        return result.Success;
    }

    public static async Task EnsureReadyAsync(DockerCli docker, Action<string> statusWriter)
    {
        statusWriter("Docker status: checking daemon…");
        if (await CanRunAsync(docker))
        {
            return;
        }

        StartDockerDesktopIfPossible();

        var deadline = DateTimeOffset.UtcNow.AddMinutes(3);
        while (DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(2500);
            if (await CanRunAsync(docker))
            {
                statusWriter("Docker status: daemon is ready");
                return;
            }

            statusWriter("Docker status: waiting for Docker Desktop…");
        }

        throw new InvalidOperationException("Docker Desktop did not become ready in time.");
    }

    public static async Task<ProcessRunResult> RunAsync(DockerCli docker, string arguments, string? workingDirectory, string? composeRoot = null, int timeoutMs = 120_000)
    {
        var psi = new ProcessStartInfo
        {
            FileName = docker.FullPath,
            Arguments = arguments,
            WorkingDirectory = composeRoot ?? workingDirectory ?? Environment.CurrentDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var process = Process.Start(psi) ?? throw new InvalidOperationException($"Failed to start {docker.DisplayPath}.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var exitTask = process.WaitForExitAsync();
        var completed = await Task.WhenAny(exitTask, Task.Delay(timeoutMs));
        if (completed != exitTask)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
            }

            var timedOutOutput = await Task.WhenAll(stdoutTask, stderrTask);
            return new ProcessRunResult(false, string.Join(Environment.NewLine, timedOutOutput));
        }

        var combined = await Task.WhenAll(stdoutTask, stderrTask);
        var success = process.ExitCode == 0;
        return new ProcessRunResult(success, string.Join(Environment.NewLine, combined));
    }

    public static async Task<List<PortConflict>> FindPortConflictsAsync(DockerCli docker, IEnumerable<int> hostPorts)
    {
        var requestedPorts = new HashSet<int>(hostPorts);
        var conflicts = new List<PortConflict>();
        var result = await RunAsync(docker, "ps --format \"{{.Names}}|{{.Ports}}\"", Directory.GetCurrentDirectory(), Directory.GetCurrentDirectory(), timeoutMs: 20_000);
        if (!result.Success || string.IsNullOrWhiteSpace(result.Output))
        {
            return conflicts;
        }

        foreach (var rawLine in result.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = rawLine.Split('|', 2);
            if (parts.Length != 2)
            {
                continue;
            }

            var containerName = parts[0].Trim();
            var portsText = parts[1];
            foreach (var hostPort in requestedPorts)
            {
                if (IsPortMapped(portsText, hostPort))
                {
                    conflicts.Add(new PortConflict(containerName, hostPort));
                }
            }
        }

        return conflicts
            .GroupBy(c => new { c.ContainerName, c.HostPort })
            .Select(g => g.First())
            .ToList();
    }

    public static string ExtractErrorSummary(string output)
    {
        if (string.IsNullOrWhiteSpace(output))
        {
            return "docker compose failed.";
        }

        var errorLines = output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(l => l.Trim())
            .Where(IsErrorLine)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(10)
            .ToList();

        if (errorLines.Count == 0)
        {
            errorLines = output
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .TakeLast(5)
                .Select(l => l.Trim())
                .ToList();
        }

        var builder = new StringBuilder("docker compose failed:");
        foreach (var line in errorLines)
        {
            builder.AppendLine();
            builder.Append("- ");
            builder.Append(line);
        }

        return builder.ToString();
    }

    public static async Task<bool> WaitForHttpAsync(string url, Action<string> statusWriter, int timeoutSeconds = 300)
    {
        using var http = new HttpClient();
        http.Timeout = TimeSpan.FromSeconds(5);

        var deadline = DateTimeOffset.UtcNow.AddSeconds(timeoutSeconds);
        while (DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                if (response.IsSuccessStatusCode)
                {
                    return true;
                }

                statusWriter($"Docker status: waiting for web app… ({(int)response.StatusCode})");
            }
            catch
            {
                statusWriter("Docker status: waiting for web app…");
            }

            await Task.Delay(2500);
        }

        return false;
    }

    public static async Task<bool> IsHttpReachableAsync(string url)
    {
        using var http = new HttpClient();
        http.Timeout = TimeSpan.FromSeconds(3);

        try
        {
            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static void StartDockerDesktopIfPossible()
    {
        foreach (var candidate in DockerDesktopCandidates)
        {
            if (!File.Exists(candidate))
            {
                continue;
            }

            try
            {
                Process.Start(new ProcessStartInfo(candidate) { UseShellExecute = true });
                return;
            }
            catch
            {
            }
        }
    }

    private static bool IsPortMapped(string portsText, int hostPort)
    {
        var markers = new[]
        {
            $"0.0.0.0:{hostPort}->",
            $"[::]:{hostPort}->",
            $"::{hostPort}->",
            $":{hostPort}->",
        };

        return markers.Any(marker => portsText.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsErrorLine(string line)
    {
        return line.Contains("error", StringComparison.OrdinalIgnoreCase)
            || line.Contains("failed", StringComparison.OrdinalIgnoreCase)
            || line.Contains("exception", StringComparison.OrdinalIgnoreCase)
            || line.Contains("address already in use", StringComparison.OrdinalIgnoreCase)
            || line.Contains("port is already allocated", StringComparison.OrdinalIgnoreCase)
            || line.Contains("cannot", StringComparison.OrdinalIgnoreCase);
    }
}