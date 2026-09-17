// A stand-in for Claude Code's native claude.exe, compiled on the Windows CI runner by
// tests/wrapper-substitution.windows.test.ts with the same .NET Framework csc.exe that
// `clodex install-vscode-launcher` uses. The test appends a sentinel plus a fake JavaScript bundle
// after the PE image (Windows ignores overlay bytes), which is what the mocked tweakcc reads and
// rewrites — so `clodex patch` can run against this file exactly as it runs against the real one.
//
// It answers `--version` (the patcher's version probe runs it through cmd.exe), and otherwise reports
// which copy of itself ran: the patched output carries clodex's `/*ccpatch:` marker in its overlay,
// the pristine copy does not. The report also echoes its arguments and the bridge environment the
// wrapper gave it, on stdout and — when CLODEX_FAKE_MARKER names a file — on disk.
//
// C# 5 only: the compiler that ships inside the .NET Framework predates string interpolation,
// expression-bodied members and `out var`.

using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class FakeClaude
{
    private static string Json(string value)
    {
        StringBuilder builder = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
            else builder.Append(c);
        }
        return builder.Append('"').ToString();
    }

    private static string EnvJson(string name)
    {
        string value = Environment.GetEnvironmentVariable(name);
        return value == null ? "null" : Json(value);
    }

    private static int Main(string[] args)
    {
        // The report can carry non-ASCII arguments; a redirected console defaults to the OEM code page.
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length > 0 && args[0] == "--version")
        {
            Console.Out.Write("2.1.273 (Claude Code)\n");
            return 0;
        }

        string self = Process.GetCurrentProcess().MainModule.FileName;
        // Latin-1 maps every byte to one char, so the marker search sees the overlay exactly.
        string image = Encoding.GetEncoding(28591).GetString(File.ReadAllBytes(self));
        string identity = image.Contains("/*ccpatch:") ? "patched-install" : "extension-bundle";

        StringBuilder report = new StringBuilder();
        report.Append("{\"identity\":").Append(Json(identity));
        report.Append(",\"pid\":").Append(Process.GetCurrentProcess().Id);
        report.Append(",\"args\":[");
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) report.Append(',');
            report.Append(Json(args[i]));
        }
        report.Append("]");
        report.Append(",\"baseUrl\":").Append(EnvJson("ANTHROPIC_BASE_URL"));
        report.Append(",\"httpProxy\":").Append(EnvJson("HTTP_PROXY"));
        report.Append(",\"httpsProxy\":").Append(EnvJson("HTTPS_PROXY"));
        report.Append(",\"caPath\":").Append(EnvJson("NODE_EXTRA_CA_CERTS"));
        report.Append('}');

        string marker = Environment.GetEnvironmentVariable("CLODEX_FAKE_MARKER");
        if (!string.IsNullOrEmpty(marker)) File.WriteAllText(marker, report.ToString(), new UTF8Encoding(false));
        Console.Out.Write(report.ToString() + "\n");
        Console.Out.Flush();

        string exit = Environment.GetEnvironmentVariable("FAKE_EXIT_CODE");
        int code;
        return exit != null && int.TryParse(exit, out code) ? code : 0;
    }
}
