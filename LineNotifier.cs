using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace ClinicLightNotifier;

public sealed class LineNotifier
{
    private const string PushUrl = "https://api.line.me/v2/bot/message/push";
    private readonly HttpClient _http;
    private readonly LineConfig _cfg;

    public LineNotifier(HttpClient http, LineConfig cfg)
    {
        _http = http;
        _cfg = cfg;
    }

    /// <summary>送出推播；失敗時只在畫面上顯示，不丟例外（推播失敗不應讓監控停止）。</summary>
    public async Task<bool> SendAsync(string text, CancellationToken ct)
    {
        Log.Info($"📣 {text.Replace("\n", " / ")}");

        if (!_cfg.IsConfigured)
        {
            Log.Warn("LINE 未設定，只在畫面顯示（請填 Line.ChannelAccessToken 與 Line.UserId）");
            Console.Beep();
            return false;
        }

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, PushUrl);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _cfg.ChannelAccessToken);
            req.Headers.Add("X-Line-Retry-Key", Guid.NewGuid().ToString()); // 重送時避免重複推播
            req.Content = JsonContent.Create(new
            {
                to = _cfg.UserId,
                messages = new[] { new { type = "text", text } },
            });

            using var res = await _http.SendAsync(req, ct);
            if (res.IsSuccessStatusCode) return true;

            var body = await res.Content.ReadAsStringAsync(ct);
            var hint = res.StatusCode switch
            {
                HttpStatusCode.Unauthorized => "Channel Access Token 錯誤或過期",
                HttpStatusCode.BadRequest => "UserId 錯誤，或你尚未把官方帳號加為好友",
                HttpStatusCode.TooManyRequests => "本月免費訊息額度用完（不會被扣款，只是推不出去）",
                _ => "",
            };
            Log.Error($"LINE 推播失敗 {(int)res.StatusCode} {hint} {body}");
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            Log.Error($"LINE 推播例外：{ex.Message}");
        }

        Console.Beep();
        return false;
    }
}
