[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SillyTavernPath,
    [string]$UserHandle = 'default-user',
    [switch]$InstallExperimental
)
$ErrorActionPreference = 'Stop'
if (-not $InstallExperimental) {
    throw 'This is the experimental TTSVoice single-copy branch. To replace the installed plugin with a backup, explicitly pass -InstallExperimental. The stable source is unchanged.'
}
if ($UserHandle -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid user handle.' }
$stRoot = (Resolve-Path -LiteralPath $SillyTavernPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $stRoot 'public\scripts\st-context.js'))) {
    throw 'The selected path is not a SillyTavern installation.'
}
$userRoot = Join-Path $stRoot "data\$UserHandle"
if (-not (Test-Path -LiteralPath $userRoot -PathType Container)) {
    throw 'User directory not found. Start SillyTavern once or specify -UserHandle.'
}
$destination = [IO.Path]::GetFullPath((Join-Path $userRoot 'extensions\sillytavern-breeze'))
if (-not $destination.StartsWith($stRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Extension destination is outside the selected installation.'
}
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
if ($sourceRoot.Equals($destination, [StringComparison]::OrdinalIgnoreCase) -or
    $sourceRoot.StartsWith($destination.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run the manual installer from a separate checkout outside the installed extension directory. Use Git update for an existing Git installation.'
}
$runtimeFiles = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'tools\runtime-files.json') -Raw | ConvertFrom-Json
$runtimeFiles = @($runtimeFiles)
if ($runtimeFiles.Count -eq 0 -or @($runtimeFiles | Select-Object -Unique).Count -ne $runtimeFiles.Count) {
    throw 'Runtime file list must be nonempty and contain no duplicates.'
}
foreach ($runtimeFile in $runtimeFiles) {
    if ($runtimeFile -isnot [string] -or $runtimeFile -notmatch '^[a-z0-9-]+\.(js|css|json)$') {
        throw "Invalid runtime filename: $runtimeFile"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $runtimeFile) -PathType Leaf)) {
        throw "Missing runtime file: $runtimeFile"
    }
}
if ($PSCmdlet.ShouldProcess($destination, 'Back up existing extension and install Breeze plugin files')) {
    if (Test-Path -LiteralPath $destination) {
        $backup = Join-Path $PSScriptRoot ('backups\' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup -Recurse
        Write-Output "Backup: $backup"
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    foreach ($runtimeFile in $runtimeFiles) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $runtimeFile) -Destination $destination -Force
    }
    Write-Output "Installed: $destination"
    Write-Output 'Reload SillyTavern. Narrator clone mode requires the updated Breeze backend; restart it after applying the backend changes.'
}
