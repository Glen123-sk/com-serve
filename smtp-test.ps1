#!/usr/bin/env pwsh
<#
.SYNOPSIS
    SMTP Tester - CLI tool to test SMTP services
.DESCRIPTION
    Validates SMTP connectivity, authentication, and optionally sends test emails.
.PARAMETER Host
    SMTP server hostname (required)
.PARAMETER Port
    SMTP port (default: 587 for STARTTLS, 465 for SSL)
.PARAMETER StarTLS
    Enable STARTTLS upgrade
.PARAMETER SSL
    Enable implicit SSL/TLS
.PARAMETER Username
    SMTP username for authentication
.PARAMETER Password
    SMTP password (or use SMTP_PASSWORD environment variable)
.PARAMETER CheckOnly
    Only test connection/login without sending mail
.PARAMETER From
    Sender email address
.PARAMETER To
    Recipient email address(es), comma-separated
.PARAMETER Subject
    Email subject (default: "SMTP Test Message")
.PARAMETER Body
    Email body text
.PARAMETER BodyFile
    Path to file containing email body
.PARAMETER TrustAll
    Accept any TLS certificate (testing only)
.PARAMETER Debug
    Enable verbose debug logging
.EXAMPLE
    # Test SMTP connection only
    .\smtp-test.ps1 -Host smtp.example.com -Port 587 -StarTLS -Username user -Password secret -CheckOnly

.EXAMPLE
    # Send a test email
    .\smtp-test.ps1 -Host smtp.example.com -Port 587 -StarTLS -Username user -Password secret `
        -From me@example.com -To you@example.com -Subject "Test" -Body "Hello"

.EXAMPLE
    # Use environment variable for password
    $env:SMTP_PASSWORD = "secret"
    .\smtp-test.ps1 -Host smtp.example.com -Port 587 -StarTLS -Username user -CheckOnly
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Host,
    
    [Parameter()]
    [int]$Port = 0,  # 0 means auto-select based on SSL/StarTLS
    
    [Parameter()]
    [switch]$StarTLS,
    
    [Parameter()]
    [switch]$SSL,
    
    [Parameter()]
    [string]$Username,
    
    [Parameter()]
    [string]$Password,
    
    [Parameter()]
    [switch]$CheckOnly,
    
    [Parameter()]
    [string]$From,
    
    [Parameter()]
    [string]$To,
    
    [Parameter()]
    [string]$Subject = "SMTP Test Message",
    
    [Parameter()]
    [string]$Body,
    
    [Parameter()]
    [string]$BodyFile,
    
    [Parameter()]
    [switch]$TrustAll,
    
    [Parameter()]
    [switch]$Debug
)

# Resolve paths
$jarPath = Join-Path $PSScriptRoot "target\smtp-tester.jar"
$java = "$env:JAVA_HOME\bin\java.exe"

# Verify JAR exists
if (-not (Test-Path $jarPath)) {
    Write-Error "JAR not found: $jarPath. Please build the project first with: mvnd -q package"
    exit 1
}

# Verify Java exists
if (-not (Test-Path $java)) {
    Write-Error "Java not found at: $java. Please set JAVA_HOME environment variable."
    exit 1
}

# Build arguments
$args = @("--host", $Host)

# Auto-detect port if not specified
if ($Port -eq 0) {
    $Port = if ($SSL) { 465 } else { 587 }
}

$args += "--port", $Port

if ($StarTLS) {
    $args += "--starttls"
}

if ($SSL) {
    $args += "--ssl"
}

if ($Username) {
    $args += "--username", $Username
    # Use provided password or fall back to env var
    $pwd = $Password
    if (-not $pwd) {
        $pwd = $env:SMTP_PASSWORD
    }
    if ($pwd) {
        $args += "--password", $pwd
    } else {
        Write-Error "Password required: provide --Password or set SMTP_PASSWORD environment variable"
        exit 1
    }
}

if ($CheckOnly) {
    $args += "--check-only"
}

if ($From) {
    $args += "--from", $From
}

if ($To) {
    $args += "--to", $To
}

if ($Subject) {
    $args += "--subject", $Subject
}

if ($Body) {
    $args += "--body", $Body
}

if ($BodyFile) {
    $args += "--body-file", $BodyFile
}

if ($TrustAll) {
    $args += "--trust-all"
}

if ($Debug) {
    $args += "--debug"
}

# Run
Write-Host "Running: $java -jar $jarPath $args" -ForegroundColor Cyan
& $java -jar $jarPath @args
