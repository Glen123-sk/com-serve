# SMTP Tester (Java)

Simple CLI utility to test SMTP services:
- Validate connectivity/login (`--check-only`)
- Send a real test email
- Toggle STARTTLS or SSL
- Enable detailed SMTP debug logs

## Requirements

- Java 17+
- Maven 3.9+

## Build

```bash
mvn -q package
```

## Usage

### Quick Start (PowerShell)

First, set environment variables (optional, for password):

```powershell
$env:JAVA_HOME = "C:\jdk-25.0.2.10-hotspot"
$env:SMTP_PASSWORD = "your-password"
```

Then run via PowerShell script:

```powershell
# Test connection only
.\smtp-test.ps1 -Host smtp.example.com -Port 587 -StarTLS -Username user -CheckOnly

# Send test email
.\smtp-test.ps1 -Host smtp.example.com -Port 587 -StarTLS -Username user `
  -From me@example.com -To you@example.com -Subject "Test" -Body "Hello"

# Multiple recipients
.\smtp-test.ps1 -Host smtp.example.com -Port 587 -StarTLS -Username user `
  -From me@example.com -To "user1@example.com,user2@example.com" -Body "Test"
```

### Direct JAR Execution

```powershell
$env:JAVA_HOME = "C:\jdk-25.0.2.10-hotspot"
& "$env:JAVA_HOME\bin\java.exe" -jar target\smtp-tester.jar --help
& "$env:JAVA_HOME\bin\java.exe" -jar target\smtp-tester.jar --host smtp.example.com --port 587 --starttls --username user --password secret --check-only
```

### Using Maven (if preferred)

```bash
mvn -q package
mvn -q exec:java -Dexec.args="--help"
```

## Important options

- `--ssl`: Use implicit TLS (usually port 465)
- `--starttls`: Upgrade plain SMTP to TLS (usually port 587)
- `--trust-all`: Accept any server certificate (testing only)
- `--debug`: Verbose protocol logs from Jakarta Mail
- `--timeout`: Socket timeout in milliseconds (default: 10000ms)

## Testing with real SMTP servers

### Gmail (with App Password)

```powershell
$env:SMTP_PASSWORD = "your-app-password"
.\smtp-test.ps1 -Host smtp.gmail.com -Port 587 -StarTLS -Username your-email@gmail.com -CheckOnly
```

### Microsoft 365

```powershell
$env:SMTP_PASSWORD = "your-password"
.\smtp-test.ps1 -Host smtp.office365.com -Port 587 -StarTLS -Username your-email@company.com -CheckOnly
```

### SendGrid

```powershell
$env:SMTP_PASSWORD = "SG.your-api-key"
.\smtp-test.ps1 -Host smtp.sendgrid.net -Port 587 -StarTLS -Username apikey -CheckOnly
```

### Local/Self-signed SMTP server

```powershell
.\smtp-test.ps1 -Host localhost -Port 25 -CheckOnly -TrustAll
```

---

# Full-Stack Authentication Website (Node.js + Express + MongoDB + SMTP OTP)

This workspace now also includes a complete authentication website:

- Frontend pages in `client/`
- Backend API in `server/`
- Real SMTP OTP for signup and password reset
- Password hashing with bcrypt
- JWT login tokens
- OTP expiry + resend + rate limiting

## API Routes

- `POST /register`
- `POST /verify-otp`
- `POST /login`
- `POST /forgot-password`
- `POST /reset-password`

## Setup

1. Copy `server/.env.example` to `server/.env`
2. Fill values for MongoDB and SMTP

Required environment variables:

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/auth_smtp_app
JWT_SECRET=replace_with_long_random_secret
JWT_EXPIRES_IN=1d
RESET_TOKEN_EXPIRES_IN=10m

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password
SMTP_FROM="Auth App <no-reply@example.com>"
```

## Run

From `server/`:

```powershell
cmd /c npm install
cmd /c npm run dev
```

Open:

- `http://localhost:5000/` for landing page
- `http://localhost:5000/health` for API health check

## Security implemented

- Password hashing with bcrypt
- Duplicate email prevention
- OTP expiry (5 minutes)
- OTP request cooldown and rate limiting
- OTP never sent to frontend responses
- JWT tokens for login and password reset authorization
