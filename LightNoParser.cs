using System.Net;
using System.Text.RegularExpressions;

namespace ClinicLightNotifier;

public sealed class LightNoParser
{
    private readonly Regex _regex;

    public LightNoParser(string pattern)
    {
        _regex = new Regex(pattern, RegexOptions.Compiled | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(2));
    }

    public int? Parse(string html)
    {
        var text = HtmlToText(html);
        var m = _regex.Match(text);
        if (!m.Success) return null;

        var raw = m.Groups.Count > 1 ? m.Groups[1].Value : m.Value;
        var digits = new string(raw.Where(char.IsDigit).ToArray());
        return int.TryParse(digits, out var n) ? n : null;
    }

    /// <summary>把 HTML 轉成一行一段的純文字，讓 Regex 不受標籤干擾。</summary>
    public static string HtmlToText(string html)
    {
        var s = Regex.Replace(html, @"<(script|style|noscript)\b[^>]*>.*?</\1>", " ",
            RegexOptions.Singleline | RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<!--.*?-->", " ", RegexOptions.Singleline);
        // 區塊類標籤換行，行內標籤換空白
        s = Regex.Replace(s, @"</?(tr|p|div|li|h\d|table|tbody|thead|section|br)\b[^>]*>", "\n", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<[^>]+>", " ");
        s = WebUtility.HtmlDecode(s);
        s = s.Replace(' ', ' ');

        var lines = s.Split('\n')
            .Select(l => Regex.Replace(l, @"[ \t\r\f\v]+", " ").Trim())
            .Where(l => l.Length > 0);
        return string.Join("\n", lines);
    }
}
