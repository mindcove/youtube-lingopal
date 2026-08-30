# 打包成可分发的 zip。
# 用白名单而不是黑名单 —— 以后新增了不该进包的文件时，不会因为忘记加排除规则就把它带出去。
# 用法： powershell -ExecutionPolicy Bypass -File pack.ps1
#
# 注意：本文件必须保存为「带 BOM 的 UTF-8」。Windows PowerShell 5.1 会把无 BOM 的
# UTF-8 脚本按系统 ANSI 码页读，中文注释和字符串会变成乱码。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$manifest = Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json
$out = Join-Path $PSScriptRoot "youtube-lingopal-v$($manifest.version).zip"
if (Test-Path $out) { Remove-Item $out -Force }

$files = @(
  'manifest.json','background.js','content.js','inject.js','i18n.js','utils.js',
  'sidepanel.html','sidepanel.js','sidepanel.css','overlay.css',
  'README.md','README.zh-CN.md','LICENSE',
  'icons/icon16.png','icons/icon48.png','icons/icon128.png',
  '_locales/en/messages.json','_locales/zh_CN/messages.json'
)

foreach ($f in $files) {
  if (-not (Test-Path $f)) { throw "missing file: $f" }
  # 密钥类文件不该出现在白名单里，写错了也拦下来
  if ($f -match '(?i)key.*\.txt|\.env$|\.pem$') { throw "refusing to pack: $f" }
}

# 不用 Compress-Archive：它在 PowerShell 5.1 下会把路径分隔符写成反斜杠，
# 不符合 ZIP 规范，部分解压工具会把 icons\icon16.png 当成一个文件名而不是子目录。
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
  foreach ($f in $files) {
    $full = (Resolve-Path $f).Path
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, $f, 'Optimal')
  }
} finally {
  $zip.Dispose()
}

Write-Host "OK  $(Split-Path $out -Leaf)  ($($files.Count) files)"
