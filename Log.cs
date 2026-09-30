namespace ClinicLightNotifier;

public static class Log
{
    private static void Write(ConsoleColor color, string tag, string msg)
    {
        var prev = Console.ForegroundColor;
        Console.ForegroundColor = color;
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {tag} {msg}");
        Console.ForegroundColor = prev;
    }

    public static void Info(string msg) => Write(ConsoleColor.Gray, "INFO ", msg);
    public static void Ok(string msg) => Write(ConsoleColor.Green, "OK   ", msg);
    public static void Warn(string msg) => Write(ConsoleColor.Yellow, "WARN ", msg);
    public static void Error(string msg) => Write(ConsoleColor.Red, "ERROR", msg);
}
