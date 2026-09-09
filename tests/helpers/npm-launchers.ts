// Verbatim launcher fixtures, captured by running npm's own cmd-shim 8.0.0 (the
// copy bundled with npm in Node 24.14.1) against a package whose `bin` is a
// native `bin/claude.exe`, and again against one whose `bin` is a `cli.js`
// carrying a `#!/usr/bin/env node` line. Both shapes have shipped as
// `@anthropic-ai/claude-code`'s bin and clodex must keep supporting both. The
// two- and three-space runs and the CRLF line endings in the `.cmd` files are
// real, not typos — do not "tidy" them.

/** cmd-shim's output for a bin target that has NO shebang (a native binary). */
export const NATIVE_LAUNCHERS = {
  sh: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n'
    + '\ncase `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n'
    + '        if command -v cygpath > /dev/null 2>&1; then\n'
    + '            basedir=`cygpath -w "$basedir"`\n        fi\n    ;;\nesac\n\n'
    + 'exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   "$@"\n',
  cmd: '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n'
    + 'SETLOCAL\r\nCALL :find_dp0\r\n'
    + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
  ps1: '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n'
    + '$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n'
    + '  # Fix case when both the Windows and Linux builds of Node\n'
    + '  # are installed in the same directory\n  $exe=".exe"\n}\n'
    + '# Support pipeline input\nif ($MyInvocation.ExpectingInput) {\n'
    + '  $input | & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args\n'
    + '} else {\n'
    + '  & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args\n'
    + '}\nexit $LASTEXITCODE\n',
};

/**
 * cmd-shim's output for a `cli.js` bin target: each launcher picks a nearby node
 * and passes the script as an argument, so the file the launcher runs FIRST is
 * node, and the one that matters is the script named last.
 */
export const LEGACY_LAUNCHERS = {
  sh: '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n'
    + '\ncase `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n'
    + '        if command -v cygpath > /dev/null 2>&1; then\n'
    + '            basedir=`cygpath -w "$basedir"`\n        fi\n    ;;\nesac\n\n'
    + 'if [ -x "$basedir/node" ]; then\n'
    + '  exec "$basedir/node"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n'
    + 'else \n'
    + '  exec node  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\nfi\n',
  cmd: '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n'
    + 'SETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n'
    + '  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n'
    + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n'
    + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  '
    + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
  ps1: '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n'
    + '$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n'
    + '  # Fix case when both the Windows and Linux builds of Node\n'
    + '  # are installed in the same directory\n  $exe=".exe"\n}\n$ret=0\n'
    + 'if (Test-Path "$basedir/node$exe") {\n  # Support pipeline input\n'
    + '  if ($MyInvocation.ExpectingInput) {\n'
    + '    $input | & "$basedir/node$exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args\n'
    + '  } else {\n'
    + '    & "$basedir/node$exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args\n'
    + '  }\n  $ret=$LASTEXITCODE\n} else {\n  # Support pipeline input\n'
    + '  if ($MyInvocation.ExpectingInput) {\n'
    + '    $input | & "node$exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args\n'
    + '  } else {\n'
    + '    & "node$exe"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args\n'
    + '  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n',
};

// cmd-shim 9.0.2 — what npm 12 resolves to through bin-links 7 — generated the
// same way from the same two bin shapes. Only the legacy `sh` launcher differs
// in a way the grammars care about: it renamed the base directory to
// `$basedir_win` and hoisted the node lookup into a `PROG_EXE` variable.

export const V9_NATIVE_LAUNCHERS = {
  sh: "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\nbasedir_win=\"$basedir\"\n\ncase `uname -a` in\n  *CYGWIN*|*MINGW*|*MSYS*)\n    if command -v cygpath > /dev/null 2>&1; then\n      basedir_win=`cygpath -w \"$basedir\"`\n    fi\n  ;;\n  *WSL2*)\n    if command -v wslpath > /dev/null 2>&1; then\n      basedir_win=\"$(wslpath -w \"$basedir\" 2> /dev/null)\"\n      if [ $? -ne 0 ] || [ -z \"$basedir_win\" ]; then\n        echo \"Error: wslpath failed to convert path. WSL environment may be misconfigured.\" >&2\n        exit 1\n      fi\n    fi\n  ;;\nesac\n\nexec \"$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe\"   \"$@\"\n",
  cmd: "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n",
  ps1: "#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=\"\"\nif ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=\".exe\"\n}\n# Support pipeline input\nif ($MyInvocation.ExpectingInput) {\n  $input | & \"$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe\"   $args\n} else {\n  & \"$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe\"   $args\n}\nexit $LASTEXITCODE\n",
};
export const V9_LEGACY_LAUNCHERS = {
  sh: "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\nbasedir_win=\"$basedir\"\n\ncase `uname -a` in\n  *CYGWIN*|*MINGW*|*MSYS*)\n    if command -v cygpath > /dev/null 2>&1; then\n      basedir_win=`cygpath -w \"$basedir\"`\n    fi\n  ;;\n  *WSL2*)\n    if command -v wslpath > /dev/null 2>&1; then\n      basedir_win=\"$(wslpath -w \"$basedir\" 2> /dev/null)\"\n      if [ $? -ne 0 ] || [ -z \"$basedir_win\" ]; then\n        echo \"Error: wslpath failed to convert path. WSL environment may be misconfigured.\" >&2\n        exit 1\n      fi\n    fi\n  ;;\nesac\n\nPROG_EXE=\"$basedir/node.exe\"\nif ! [ -x \"$PROG_EXE\" ]; then\n  PROG_EXE=\"$basedir/node\"\n  if ! [ -x \"$PROG_EXE\" ]; then\n    PROG_EXE=node\n    if ! [ -x \"$PROG_EXE\" ]; then\n      PROG_EXE=node.exe\n    fi\n  fi\nfi\n\nexec \"$PROG_EXE\"  \"$basedir_win/node_modules/@anthropic-ai/claude-code/cli.js\" \"$@\"\n",
  cmd: "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n",
  ps1: "#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=\"\"\nif ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {\n  # Fix case when both the Windows and Linux builds of Node\n  # are installed in the same directory\n  $exe=\".exe\"\n}\n$ret=0\nif (Test-Path \"$basedir/node$exe\") {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & \"$basedir/node$exe\"  \"$basedir/node_modules/@anthropic-ai/claude-code/cli.js\" $args\n  } else {\n    & \"$basedir/node$exe\"  \"$basedir/node_modules/@anthropic-ai/claude-code/cli.js\" $args\n  }\n  $ret=$LASTEXITCODE\n} else {\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {\n    $input | & \"node$exe\"  \"$basedir/node_modules/@anthropic-ai/claude-code/cli.js\" $args\n  } else {\n    & \"node$exe\"  \"$basedir/node_modules/@anthropic-ai/claude-code/cli.js\" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n",
};
