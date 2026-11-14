# Run the onboarding agent in Supabase mode from Windows PowerShell.
# Signs in as a store staff user (email + password prompt; nothing is saved), then calls POST /api/agent/onboard.
# Usage (from the project folder, with `npm run dev` running):
#   powershell -ExecutionPolicy Bypass -File scripts\onboard-supabase.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\onboard-supabase.ps1 -Property 9560712 -Store demo-store
param(
  [string]$Property = "bP9oEnqmeie",
  [string]$Store = "demo-store",
  [string]$App = "http://localhost:3000"
)
$ErrorActionPreference = "Stop"

function Get-EnvValue([string]$name) {
  $m = Select-String -Path ".env.local" -Pattern "^$name=(\S+)" | Select-Object -First 1
  if (-not $m) { throw "$name is not set in .env.local" }
  $m.Matches[0].Groups[1].Value
}
$url = Get-EnvValue "NEXT_PUBLIC_SUPABASE_URL"
$anon = Get-EnvValue "NEXT_PUBLIC_SUPABASE_ANON_KEY"

$cred = Get-Credential -Message "Supabase staff email and password"
$login = @{ email = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json
try {
  $session = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/token?grant_type=password" -Headers @{ apikey = $anon } -ContentType "application/json" -Body $login
} catch {
  Write-Host "Sign-in failed: $($_.ErrorDetails.Message)" -ForegroundColor Red
  exit 1
}
Write-Host "Signed in. Running onboarding for $Property (store $Store); this takes 1-3 minutes..."

$body = @{ costar_property_id = $Property; store_id = $Store } | ConvertTo-Json
try {
  $result = Invoke-RestMethod -Method Post -Uri "$App/api/agent/onboard" -TimeoutSec 400 `
    -Headers @{ authorization = "Bearer $($session.access_token)" } -ContentType "application/json" -Body $body
  $result | ConvertTo-Json -Depth 8
} catch {
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { "no response" }
  Write-Host "HTTP $code : $($_.ErrorDetails.Message) $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
