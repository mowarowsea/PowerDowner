#Requires -Version 5.1
<#
  PowerDowner 用の外部ツールを tools/ 配下に「置くだけ」で用意する (インストールしない)。
    - aria2c.exe          (GitHub Releases の Windows 64bit ビルド)
    - Temurin JRE (zip)   (Adoptium API から最新 GA を取得)
    - JDownloader.jar     (installer.jdownloader.org の jar 版インストーラ)
  併せて JD2 の Deprecated API (127.0.0.1:3128) を有効化する設定ファイルを書く。

  使い方:  powershell -ExecutionPolicy Bypass -File scripts\fetch-tools.ps1
  個別スキップ:  -SkipAria2 / -SkipJre / -SkipJd2
#>
param(
  [switch]$SkipAria2,
  [switch]$SkipJre,
  [switch]$SkipJd2,
  [string]$Aria2Version = '1.37.0',
  [int]$JavaMajor = 17
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root  = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Get-File([string]$Url, [string]$Dest) {
  Write-Host "  <- $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
  $size = (Get-Item $Dest).Length
  Write-Host ("  -> {0} ({1:N1} MB)" -f $Dest, ($size / 1MB))
}

# ---- aria2 -----------------------------------------------------------------
if (-not $SkipAria2) {
  $dir = Join-Path $tools 'aria2'
  $exe = Join-Path $dir 'aria2c.exe'
  if (Test-Path $exe) {
    Write-Host "[aria2] 既に存在: $exe"
  } else {
    Write-Host "[aria2] 取得中 ($Aria2Version)"
    $zip = Join-Path $env:TEMP "aria2-$Aria2Version.zip"
    $url = "https://github.com/aria2/aria2/releases/download/release-$Aria2Version/aria2-$Aria2Version-win-64bit-build1.zip"
    Get-File $url $zip
    $tmp = Join-Path $env:TEMP 'aria2-extract'
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $tmp
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $found = Get-ChildItem $tmp -Recurse -Filter 'aria2c.exe' | Select-Object -First 1
    if (-not $found) { throw 'zip 内に aria2c.exe が見つかりません' }
    Copy-Item $found.FullName $exe
    Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue
    Write-Host "[aria2] OK: $exe"
  }
}

# ---- Temurin JRE (portable) ------------------------------------------------
if (-not $SkipJre) {
  $dir = Join-Path $tools 'jre'
  if (Test-Path (Join-Path $dir 'bin\java.exe')) {
    Write-Host "[jre] 既に存在: $dir"
  } else {
    Write-Host "[jre] 取得中 (Temurin $JavaMajor JRE, zip)"
    $zip = Join-Path $env:TEMP "temurin-jre-$JavaMajor.zip"
    $url = "https://api.adoptium.net/v3/binary/latest/$JavaMajor/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk"
    Get-File $url $zip
    $tmp = Join-Path $env:TEMP 'jre-extract'
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $tmp
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $inner) { throw 'zip の展開結果が空です' }
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    Move-Item $inner.FullName $dir
    Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue
    Write-Host "[jre] OK: $dir"
  }
}

# ---- JDownloader 2 ---------------------------------------------------------
if (-not $SkipJd2) {
  $dir = Join-Path $tools 'jd2'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $jar = Join-Path $dir 'JDownloader.jar'
  if (Test-Path $jar) {
    Write-Host "[jd2] 既に存在: $jar"
  } else {
    Write-Host '[jd2] 取得中 (JDownloader.jar)'
    Get-File 'http://installer.jdownloader.org/JDownloader.jar' $jar
    Write-Host "[jd2] OK: $jar"
  }

  # Deprecated API の有効化。JD2 停止中に書く必要がある。
  $cfgDir = Join-Path $dir 'cfg'
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  $apiCfg = Join-Path $cfgDir 'org.jdownloader.api.RemoteAPIConfig.json'
  if (Test-Path $apiCfg) {
    Write-Host "[jd2] API 設定は既にあります: $apiCfg (deprecatedapienabled が true か確認してください)"
  } else {
    '{"deprecatedapienabled":true,"deprecatedapiport":3128}' | Set-Content -Encoding ASCII -Path $apiCfg
    Write-Host "[jd2] Deprecated API を有効化: $apiCfg"
  }
}

Write-Host ''
Write-Host '完了。次の手順:'
Write-Host '  1. scripts\start-jd2.cmd で JD2 を起動 (初回は自動アップデートで数分。GUI が出たらそのまま常駐)'
Write-Host '  2. npm run dev で PowerDowner を起動 -> http://localhost:3939/'
