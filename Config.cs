using System.Text.Json;

namespace ClinicLightNotifier;

public sealed class AppConfig
{
    public string PageUrl { get; set; } = "";
    public int MyNumber { get; set; }
    public int[] Thresholds { get; set; } = [10, 5, 2];
    public ParseConfig Parse { get; set; } = new();
    public PollingConfig Polling { get; set; } = new();
    public LineConfig Line { get; set; } = new();

    public static AppConfig Load(string path)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"找不到設定檔：{path}");

        var opts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };
        var cfg = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(path), opts)
            ?? throw new InvalidOperationException("設定檔格式錯誤");

        // 機密只放在 appsettings.local.json（不進 git）或環境變數（GitHub Secrets）
        var localPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path))!, "appsettings.local.json");
        if (File.Exists(localPath))
        {
            var local = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(localPath), opts);
            if (!string.IsNullOrWhiteSpace(local?.Line.ChannelAccessToken)) cfg.Line.ChannelAccessToken = local.Line.ChannelAccessToken;
            if (!string.IsNullOrWhiteSpace(local?.Line.UserId)) cfg.Line.UserId = local.Line.UserId;
        }
        if (Environment.GetEnvironmentVariable("LINE_CHANNEL_ACCESS_TOKEN") is { Length: > 0 } tok) cfg.Line.ChannelAccessToken = tok;
        if (Environment.GetEnvironmentVariable("LINE_USER_ID") is { Length: > 0 } uid) cfg.Line.UserId = uid;

        cfg.Thresholds = cfg.Thresholds.Where(t => t > 0).Distinct().OrderByDescending(t => t).ToArray();
        return cfg;
    }

    public IEnumerable<string> Validate(bool needPage)
    {
        if (needPage && string.IsNullOrWhiteSpace(PageUrl)) yield return "PageUrl 未設定";
        if (needPage && MyNumber <= 0) yield return "MyNumber 必須大於 0";
        if (string.IsNullOrWhiteSpace(Parse.Regex)) yield return "Parse.Regex 未設定";
    }
}

public sealed class ParseConfig
{
    /// <summary>套用在「去除 HTML 標籤後的純文字」上，第一個擷取群組必須是目前號碼。</summary>
    public string Regex { get; set; } = "";
}

public sealed class PollingConfig
{
    public int FarIntervalSeconds { get; set; } = 120;
    public int NearIntervalSeconds { get; set; } = 30;
    public int NearWithin { get; set; } = 10;
    public int MaxBackoffSeconds { get; set; } = 240;
    public int AlertAfterFailures { get; set; } = 3;
    public int StopAfterMinutes { get; set; } = 300;
}

public sealed class LineConfig
{
    public string ChannelAccessToken { get; set; } = "";
    public string UserId { get; set; } = "";

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(ChannelAccessToken) && !string.IsNullOrWhiteSpace(UserId);
}
