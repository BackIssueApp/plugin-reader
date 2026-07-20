# Upload the panel-detection model to the BackIssue static CDN (R2), next to
# the Android APK. Publishes a versioned file + the manifest the reader's
# auto-downloader reads (models/panels-latest.json).
#
#   Requires (same as the APK release script):
#     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID
#
#   .\upload-model.ps1 -Model ..\..\..\models\panels.onnx -Engine ml-box-v2
param(
  [string]$Model = (Join-Path $PSScriptRoot '..\..\..\models\panels.onnx'),
  [Parameter(Mandatory = $true)][string]$Engine
)
$ErrorActionPreference = 'Stop'

foreach ($v in 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID') {
  if (-not (Get-Item "env:$v" -ErrorAction SilentlyContinue)) { throw "missing env var $v" }
}
$Model = (Resolve-Path $Model).Path
$sha = (Get-FileHash $Model -Algorithm SHA256).Hash.ToLower()
$bytes = (Get-Item $Model).Length
$versioned = 'panels.onnx'  # flat layout, like backissue.apk
$publicBase = 'https://static.backissue.app'

$manifest = @{ url = "$publicBase/$versioned"; sha256 = $sha; bytes = $bytes; engine = $Engine } | ConvertTo-Json
$manifestPath = Join-Path $env:TEMP 'panels-latest.json'
# The reader parses this with a strict schema; write UTF-8 without BOM.
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

$aws = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' }
$endpoint = "https://$($env:R2_ACCOUNT_ID).r2.cloudflarestorage.com"
$env:AWS_ACCESS_KEY_ID = $env:R2_ACCESS_KEY_ID
$env:AWS_SECRET_ACCESS_KEY = $env:R2_SECRET_ACCESS_KEY

Write-Host "uploading $versioned ($([math]::Round($bytes/1MB))MB, sha $($sha.Substring(0,8))…)"
& $aws s3 cp $Model "s3://static/$versioned" --endpoint-url $endpoint --content-type 'application/octet-stream'
& $aws s3 cp $manifestPath 's3://static/panels-latest.json' --endpoint-url $endpoint --content-type 'application/json' --cache-control 'no-cache'
Write-Host "done — manifest: $publicBase/panels-latest.json"
