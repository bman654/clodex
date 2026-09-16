// clodex-claude-launcher.cs - the Windows executable behind `clodex install-vscode-launcher`.
//
// The Claude Code VS Code extension spawns its `claudeCode.claudeProcessWrapper` as a bare
// executable (no shell) with the bundled claude.exe as the first argument. npm gives clodex-claude
// three script shims on Windows (extensionless, .cmd, .ps1) and no executable; the spawn rejects
// them with `spawn EINVAL`. This program is
// the .exe the extension can spawn: it runs `node.exe dist/claude-wrapper.js` with the extension's
// arguments passed through with their values intact, and keeps the whole Node -> claude tree tied to its own
// lifetime so cancelling a chat leaves no orphan processes.
//
// `clodex install-vscode-launcher` bakes two absolute paths into the placeholders below and compiles
// this file with the C# compiler that ships inside the .NET Framework on every Windows 10/11
// machine (csc.exe under %WINDIR%\Microsoft.NET\Framework64\v4.0.30319). That compiler stops at
// C# 5, so this file deliberately uses no string interpolation, no `?.`, no expression-bodied
// members and no `nameof`.
//
// Argument forwarding does NOT go through `string[] args`: .NET Framework has no ArgumentList, and
// hand-written re-quoting under the C runtime's rules is error-prone for JSON, empty strings and
// trailing backslashes. Instead the raw command line from GetCommandLineW has its first token (this
// executable's own path, quoted or not) removed and the remainder is appended to the child's
// command line untouched. Node then parses it with the same C-runtime rules the extension wrote
// it for, so the argument values Node sees - Unicode included - are the ones the extension sent.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class ClodexClaudeLauncher
{
    // Both constants are replaced by `clodex install-vscode-launcher` before compilation.
    private const string NodePath = "__CLODEX_NODE_PATH__";
    private const string WrapperScriptPath = "__CLODEX_WRAPPER_SCRIPT_PATH__";

    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint CTRL_C_EVENT = 0;
    private const uint CTRL_BREAK_EVENT = 1;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint RESUME_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    private delegate bool ConsoleCtrlHandler(uint ctrlType);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment,
        string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);

    // Held in a static so the garbage collector never reclaims the delegate the console still calls.
    private static readonly ConsoleCtrlHandler CtrlHandler = new ConsoleCtrlHandler(OnConsoleCtrl);

    /// <summary>
    /// Everything after the first token of a Windows command line. The token boundary follows the
    /// C runtime's rule for argv[0]: a leading quote ends at the next quote with no escape
    /// processing; otherwise the token ends at the first space or tab. Leading whitespace after
    /// the token is dropped; the rest - every quote, backslash and empty "" - is returned verbatim.
    /// </summary>
    internal static string ArgumentsAfterFirstToken(string commandLine)
    {
        int length = commandLine.Length;
        int index = 0;
        if (length > 0 && commandLine[0] == '"')
        {
            index = 1;
            while (index < length && commandLine[index] != '"') index++;
            if (index < length) index++;
        }
        else
        {
            while (index < length && commandLine[index] != ' ' && commandLine[index] != '\t') index++;
        }
        while (index < length && (commandLine[index] == ' ' || commandLine[index] == '\t')) index++;
        return commandLine.Substring(index);
    }

    /// <summary>The child command line: node and the wrapper script quoted, then the caller's arguments.</summary>
    internal static string BuildChildCommandLine(string node, string script, string forwardedArguments)
    {
        string head = "\"" + node + "\" \"" + script + "\"";
        return forwardedArguments.Length == 0 ? head : head + " " + forwardedArguments;
    }

    /// <summary>The baked node.exe if it still exists, else the first node.exe on PATH, else null.</summary>
    private static string ResolveNode()
    {
        if (File.Exists(NodePath)) return NodePath;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string entry in path.Split(';'))
        {
            string directory = entry.Trim().Trim('"');
            if (directory.Length == 0) continue;
            try
            {
                string candidate = Path.Combine(directory, "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException)
            {
                // An unusable PATH entry (illegal characters) is skipped, not fatal.
            }
        }
        return null;
    }

    private static bool OnConsoleCtrl(uint ctrlType)
    {
        // Ctrl+C / Ctrl+Break reach the child through the shared console; the launcher only keeps
        // waiting so it can report the child's real exit code. Close/logoff/shutdown keep the default
        // handling - the job object takes the child down with this process.
        return ctrlType == CTRL_C_EVENT || ctrlType == CTRL_BREAK_EVENT;
    }

    private static void Warn(string message)
    {
        Console.Error.WriteLine("clodex-claude.exe: warning: " + message);
    }

    private static int Fail(string message, int exitCode)
    {
        Console.Error.WriteLine("clodex-claude.exe: " + message);
        return exitCode;
    }

    private static string LastError()
    {
        return "Windows error " + Marshal.GetLastWin32Error();
    }

    /// <summary>
    /// A kill-on-close job, or IntPtr.Zero after one warning. Created before the child runs, so a
    /// launcher killed by the extension (cancel, window reload, editor exit) takes Node and the
    /// claude grandchild with it. The handle is deliberately never closed once a child is inside -
    /// the OS closes it when this process ends, which is exactly the moment the tree must die.
    /// </summary>
    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            Warn("could not create a job object (" + LastError() + "); cancellation cleanup is not guaranteed");
            return IntPtr.Zero;
        }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        {
            Warn("could not configure the job object (" + LastError() + "); cancellation cleanup is not guaranteed");
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    private static int Main()
    {
        if (!File.Exists(WrapperScriptPath))
        {
            return Fail("clodex's claude-wrapper.js is no longer at " + WrapperScriptPath
                + "; re-run `clodex install-vscode-launcher`", 127);
        }
        string node = ResolveNode();
        if (node == null)
        {
            return Fail("node.exe is no longer at " + NodePath
                + " and none was found on PATH; re-run `clodex install-vscode-launcher`", 127);
        }

        string forwarded = ArgumentsAfterFirstToken(Marshal.PtrToStringUni(GetCommandLineW()));
        StringBuilder commandLine = new StringBuilder(BuildChildCommandLine(node, WrapperScriptPath, forwarded));

        IntPtr job = CreateKillOnCloseJob();

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

        SetConsoleCtrlHandler(CtrlHandler, true);

        // Environment and working directory are inherited (null). The child starts suspended so it
        // is inside the job before it can spawn anything of its own.
        PROCESS_INFORMATION child;
        bool created = CreateProcessW(node, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED,
            IntPtr.Zero, null, ref startup, out child);
        if (!created)
        {
            return Fail("could not start " + node + " (" + LastError() + ")", 127);
        }
        if (job != IntPtr.Zero && !AssignProcessToJobObject(job, child.hProcess))
        {
            Warn("could not attach node to the job object (" + LastError() + "); cancellation cleanup is not guaranteed");
        }

        uint resumed = ResumeThread(child.hThread);
        string resumeError = resumed == RESUME_FAILED ? LastError() : null;
        CloseHandle(child.hThread);
        if (resumeError != null)
        {
            TerminateProcess(child.hProcess, 1);
            CloseHandle(child.hProcess);
            return Fail("could not resume node after starting it (" + resumeError + ")", 1);
        }

        if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0)
        {
            string reason = LastError();
            TerminateProcess(child.hProcess, 1);
            CloseHandle(child.hProcess);
            return Fail("waiting for node failed (" + reason + "); node was terminated", 1);
        }
        uint exitCode;
        bool haveExitCode = GetExitCodeProcess(child.hProcess, out exitCode);
        string exitCodeError = haveExitCode ? null : LastError();
        CloseHandle(child.hProcess);
        if (!haveExitCode)
        {
            return Fail("could not read node's exit code (" + exitCodeError + ")", 1);
        }
        return unchecked((int)exitCode);
    }
}
