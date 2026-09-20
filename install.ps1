[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SillyTavernPath = 'G:\study\AI\SillyTavern-Launcher\SillyTavern',
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
$source = Join-Path $PSScriptRoot 'extension'
if ($PSCmdlet.ShouldProcess($destination, 'Back up existing extension and install Breeze plugin files')) {
    if (Test-Path -LiteralPath $destination) {
        $backup = Join-Path $PSScriptRoot ('backups\' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup -Recurse
        Write-Output "Backup: $backup"
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath $source -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
    Write-Output "Installed: $destination"
    Write-Output 'Reload SillyTavern. Narrator clone mode requires the updated Breeze backend; restart it after applying the backend changes.'
}
