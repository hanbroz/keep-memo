# 창 하나를 제목으로 찾아 PNG 로 담는다. 개발 중 눈으로 확인할 때만 쓴다.
# 앱 코드가 아니라 도구다 — Keep 이나 state.json 에는 손대지 않는다.
param(
  [Parameter(Mandatory=$true)][string]$TitleLike,
  [Parameter(Mandatory=$true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

[void][Win]::SetProcessDPIAware()

$p = Get-Process | Where-Object { $_.MainWindowTitle -like $TitleLike } | Select-Object -First 1
if ($null -eq $p) {
  Write-Output "NOTFOUND: 제목이 '$TitleLike' 인 창이 없습니다"
  Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | ForEach-Object { Write-Output ("  창: " + $_.MainWindowTitle) }
  exit 1
}

[void][Win]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 700

$r = New-Object Win+RECT
[void][Win]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L
$h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Output "BADRECT: $w x $h"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "OK: $Out ($w x $h) <- '$($p.MainWindowTitle)'"
