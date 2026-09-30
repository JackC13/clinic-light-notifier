namespace ClinicLightNotifier;

/// <summary>
/// 監控主邏輯：與「怎麼取得目前號碼」解耦，方便用 --simulate 測試。
/// </summary>
public sealed class LightMonitor
{
    private readonly AppConfig _cfg;
    private readonly Func<CancellationToken, Task<int?>> _readCurrent;
    private readonly LineNotifier _notifier;
    private readonly Func<TimeSpan, TimeSpan> _scaleDelay;

    public LightMonitor(
        AppConfig cfg,
        Func<CancellationToken, Task<int?>> readCurrent,
        LineNotifier notifier,
        Func<TimeSpan, TimeSpan>? scaleDelay = null)
    {
        _cfg = cfg;
        _readCurrent = readCurrent;
        _notifier = notifier;
        _scaleDelay = scaleDelay ?? (t => t);
    }

    public async Task<int> RunAsync(CancellationToken ct)
    {
        var p = _cfg.Polling;
        var my = _cfg.MyNumber;
        var sentThresholds = new HashSet<int>();
        var deadline = DateTime.Now.AddMinutes(p.StopAfterMinutes);

        int? last = null;
        var failures = 0;
        var failureAlertSent = false;
        var dropAlertSent = false;
        var started = false;

        Log.Info($"開始監控：我的號碼 {my}，門檻 [{string.Join(", ", _cfg.Thresholds)}]，最長 {p.StopAfterMinutes} 分鐘");

        while (!ct.IsCancellationRequested)
        {
            if (DateTime.Now > deadline)
            {
                await _notifier.SendAsync($"⏹ 監控已達 {p.StopAfterMinutes} 分鐘自動結束（最後號碼 {last?.ToString() ?? "未知"}，你是 {my} 號）", ct);
                return 2;
            }

            int? current = null;
            try
            {
                current = await _readCurrent(ct);
                if (current is null) Log.Warn("頁面抓到了，但解析不到目前號碼（Regex 沒對到）");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                Log.Warn($"抓取失敗：{ex.Message}");
            }

            // ── 失敗處理：指數退避 + 連續失敗警告 ──
            if (current is null)
            {
                failures++;
                if (failures >= p.AlertAfterFailures && !failureAlertSent)
                {
                    await _notifier.SendAsync($"⚠️ 已連續 {failures} 次抓不到燈號，請自己看一下網頁（程式仍會繼續重試）", ct);
                    failureAlertSent = true;
                }

                var baseSec = last is int l && my - l <= p.NearWithin ? p.NearIntervalSeconds : p.FarIntervalSeconds;
                var backoff = Math.Min(baseSec * Math.Pow(2, failures - 1), p.MaxBackoffSeconds);
                // 靠近自己號碼時，退避不要超過 60 秒
                if (last is int l2 && my - l2 <= p.NearWithin) backoff = Math.Min(backoff, 60);
                Log.Info($"{backoff:0} 秒後重試（第 {failures} 次失敗）");
                if (!await DelayAsync(TimeSpan.FromSeconds(backoff), ct)) break;
                continue;
            }

            if (failureAlertSent)
                await _notifier.SendAsync($"✅ 燈號恢復讀取，目前 {current} 號", ct);
            failures = 0;
            failureAlertSent = false;

            var now = current.Value;
            var remaining = my - now;

            if (!started)
            {
                started = true;
                await _notifier.SendAsync($"▶️ 開始監控：目前 {now} 號，你是 {my} 號（還有 {Math.Max(remaining, 0)} 號）", ct);
            }

            // ── 號碼倒退：可能頁面改版、換診次或網址錯 ──
            if (last is int prev && now < prev && !dropAlertSent)
            {
                await _notifier.SendAsync($"⚠️ 燈號從 {prev} 變成 {now}（變小了），請確認網址是否為今天這一診", ct);
                dropAlertSent = true;
            }

            if (last != now) Log.Ok($"目前 {now} 號，你是 {my} 號，還有 {Math.Max(remaining, 0)} 號");
            else Log.Info($"目前 {now} 號（無變化）");
            last = now;

            // ── 到號 / 過號：推最後一則後結束 ──
            if (remaining <= 0)
            {
                var msg = remaining == 0
                    ? $"🔔 輪到你了！目前 {now} 號 = 你的號碼"
                    : $"🚨 燈號 {now} 已超過你的 {my} 號，請立刻到診間報到";
                await _notifier.SendAsync(msg, ct);
                return 0;
            }

            // ── 門檻推播：用 <= 判斷避免跳號錯過；一次跳過多個門檻只推一則 ──
            var crossed = _cfg.Thresholds.Where(t => remaining <= t && !sentThresholds.Contains(t)).ToList();
            if (crossed.Count > 0)
            {
                foreach (var t in crossed) sentThresholds.Add(t);
                var emoji = remaining <= 2 ? "🔴" : remaining <= 5 ? "🟠" : "🟡";
                await _notifier.SendAsync($"{emoji} 剩 {remaining} 號！目前 {now} 號，你是 {my} 號", ct);
            }

            var interval = remaining <= p.NearWithin ? p.NearIntervalSeconds : p.FarIntervalSeconds;
            if (!await DelayAsync(TimeSpan.FromSeconds(interval), ct)) break;
        }

        Log.Info("已手動停止");
        return 1;
    }

    private async Task<bool> DelayAsync(TimeSpan t, CancellationToken ct)
    {
        try
        {
            await Task.Delay(_scaleDelay(t), ct);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }
}
