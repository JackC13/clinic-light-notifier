using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using ClinicLightNotifier;

Console.OutputEncoding = Encoding.UTF8;

// ── 參數 ──
//   (無)                 正式監控
//   --dump               抓一次頁面，存成 page.html 並列出含數字的文字行，用來調整 Regex
//   --test-line          只送一則 LINE 測試訊息
//   --simulate           不連網站，用假燈號快速跑完整流程（含 LINE 推播）
//   --parse-file FILE    用已存的 HTML 檔測試 Regex（不連網）
//   --number N           覆寫 MyNumber
//   --url URL            覆寫 PageUrl
//   --config PATH        指定設定檔
var argList = args.ToList();
string? Opt(string name)
{
    var i = argList.IndexOf(name);
    return i >= 0 && i + 1 < argList.Count ? argList[i + 1] : null;
}
bool Flag(string name) => argList.Contains(name);

var configPath = Opt("--config")
    ?? new[] { Path.Combine(Directory.GetCurrentDirectory(), "appsettings.json"),
               Path.Combine(AppContext.BaseDirectory, "appsettings.json") }
       .FirstOrDefault(File.Exists)
    ?? "appsettings.json";

AppConfig cfg;
try { cfg = AppConfig.Load(configPath); }
catch (Exception ex) { Log.Error(ex.Message); return 1; }

if (int.TryParse(Opt("--number"), out var n)) cfg.MyNumber = n;
if (Opt("--url") is { } u) cfg.PageUrl = u;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

using var lineHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
var notifier = new LineNotifier(lineHttp, cfg.Line);

// ── LINE 測試 ──
if (Flag("--test-line"))
{
    if (!cfg.Line.IsConfigured) { Log.Error("請先在 appsettings.json 填 Line.ChannelAccessToken 與 Line.UserId"); return 1; }
    var ok = await notifier.SendAsync($"✅ 看診燈號提醒：LINE 推播測試成功（{DateTime.Now:HH:mm:ss}）", cts.Token);
    if (ok) Log.Ok("已送出，請看手機 LINE");
    return ok ? 0 : 1;
}

// ── 模擬 ──
if (Flag("--simulate"))
{
    if (cfg.MyNumber <= 0) cfg.MyNumber = 25;
    var rnd = new Random();
    var fake = Math.Max(1, cfg.MyNumber - 14);
    Log.Info($"模擬模式：從 {fake} 號開始，每輪 +0~3 號（含跳號），等待時間縮短為 1/60");
    var sim = new LightMonitor(cfg, _ =>
    {
        var v = fake;
        fake += rnd.Next(0, 4);
        return Task.FromResult<int?>(v);
    }, notifier, t => TimeSpan.FromMilliseconds(Math.Max(t.TotalMilliseconds / 60, 300)));
    return await sim.RunAsync(cts.Token);
}

var errors = cfg.Validate(needPage: true).ToList();
if (errors.Count > 0) { errors.ForEach(Log.Error); return 1; }

// ── 抓網頁用的 HttpClient：像一般瀏覽器、保留 cookie ──
var handler = new HttpClientHandler
{
    AutomaticDecompression = DecompressionMethods.All,
    UseCookies = true,
    CookieContainer = new CookieContainer(),
};
using var pageHttp = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
pageHttp.DefaultRequestHeaders.UserAgent.ParseAdd(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
pageHttp.DefaultRequestHeaders.AcceptLanguage.ParseAdd("zh-TW,zh;q=0.9");
pageHttp.DefaultRequestHeaders.Accept.ParseAdd("text/html,application/xhtml+xml");

async Task<string> FetchAsync(CancellationToken ct)
{
    using var res = await pageHttp.GetAsync(cfg.PageUrl, ct);
    res.EnsureSuccessStatusCode();
    return await res.Content.ReadAsStringAsync(ct);
}

LightNoParser parser;
try { parser = new LightNoParser(cfg.Parse.Regex); }
catch (ArgumentException ex) { Log.Error($"Parse.Regex 格式錯誤：{ex.Message}"); return 1; }

// ── 用已存的 HTML 檔測試 Regex（不連網） ──
if (Opt("--parse-file") is { } file)
{
    var r = parser.Parse(File.ReadAllText(file));
    if (r is int v) Log.Ok($"解析結果：{v} 號"); else Log.Warn("Regex 沒對到");
    return r is null ? 1 : 0;
}

// ── Dump：找出號碼在頁面的哪裡 ──
if (Flag("--dump"))
{
    string html;
    try { html = await FetchAsync(cts.Token); }
    catch (Exception ex) { Log.Error($"抓取失敗：{ex.Message}"); return 1; }

    File.WriteAllText("page.html", html);
    var text = LightNoParser.HtmlToText(html);
    File.WriteAllText("page.txt", text);
    Log.Ok($"已存 page.html（{html.Length:N0} 字元）與 page.txt");

    Console.WriteLine("\n── 含數字的文字行（號碼通常在這裡面）──");
    foreach (var line in text.Split('\n').Where(l => Regex.IsMatch(l, @"\d")).Take(80))
        Console.WriteLine("  " + (line.Length > 120 ? line[..120] + "…" : line));

    var result = parser.Parse(html);
    Console.WriteLine();
    if (result is int r) Log.Ok($"目前的 Regex 解析結果：{r} 號（跟網頁上看到的一樣就可以開始用了）");
    else Log.Warn("目前的 Regex 沒對到。把上面顯示號碼的那一行貼給 Claude，或自己改 Parse.Regex");
    return result is null ? 1 : 0;
}

// ── 正式監控 ──
var monitor = new LightMonitor(cfg, async ct => parser.Parse(await FetchAsync(ct)), notifier);
return await monitor.RunAsync(cts.Token);
