# Real input for the manual UI check: screenshots of a window and mouse/keyboard input.
#   ui-driver.ps1 -Title <part of window title> -Action shot  -Out file.png
#   ui-driver.ps1 -Title <...> -Action click -X 100 -Y 200      (window-relative pixels)
#   ui-driver.ps1 -Title <...> -Action keys  -Text "^a"         (SendKeys syntax)
#   ui-driver.ps1 -Title <...> -Action type  -Text "literal text"
# Prints the window rectangle and a millisecond timestamp of the input.
param([string]$Title, [string]$Action, [int]$X = 0, [int]$Y = 0, [string]$Text = '', [string]$Out = '')
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class U {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct R { public int L, T, Ri, B; }
}
"@
[U]::SetProcessDPIAware() | Out-Null
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $p) { Write-Error "window '$Title' not found"; exit 2 }
$h = $p.MainWindowHandle
$r = New-Object U+R; [U]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Ri - $r.L; $hh = $r.B - $r.T
switch ($Action) {
  'shot' {
    $b = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($b); $dc = $g.GetHdc(); [U]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
    $b.Save($Out); "shot ${w}x${hh} at $($r.L),$($r.T)"
  }
  'click' {
    [U]::ShowWindow($h, 9) | Out-Null; [U]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 150
    [U]::SetCursorPos($r.L + $X, $r.T + $Y) | Out-Null; Start-Sleep -Milliseconds 60
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    [U]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); [U]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
    "click $X,$Y t=$t"
  }
  'keys' {
    [U]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 150
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); [System.Windows.Forms.SendKeys]::SendWait($Text); "keys t=$t"
  }
  'type' {
    [U]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 150
    $esc = ($Text -replace '([+^%~(){}\[\]])', '{$1}')
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); [System.Windows.Forms.SendKeys]::SendWait($esc); "type t=$t"
  }
}
