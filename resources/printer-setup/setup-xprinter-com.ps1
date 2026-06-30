param(
  [string]$PrinterName = "Xprinter COM8 Receipt (Generic)",
  [string]$PortName = "COM8:",
  [string]$DriverName = "Generic / Text Only"
)

$ErrorActionPreference = "Stop"

if (-not (Get-PrinterPort -Name $PortName -ErrorAction SilentlyContinue)) {
  Add-PrinterPort -Name $PortName
}

$existing = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if ($existing) {
  Set-Printer -Name $PrinterName -PortName $PortName
} else {
  Add-Printer -Name $PrinterName -DriverName $DriverName -PortName $PortName
}

Write-Host "Yamzo receipt printer is configured:"
Write-Host "  Printer: $PrinterName"
Write-Host "  Port:    $PortName"
Write-Host "  Driver:  $DriverName"
