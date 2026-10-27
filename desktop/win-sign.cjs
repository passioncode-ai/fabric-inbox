'use strict';
/**
 * B-195: electron-builder's Windows signing hook (`win.signtoolOptions.sign`) for the uninstaller and the installer.
 * It signs with the ArtifactSigning PowerShell module the shared `windows-signing` action installed earlier in the
 * same release job, with that action's own settings (SHA-256, Microsoft's RFC 3161 timestamp, only the Azure CLI
 * credential of this job), so electron-builder no longer downloads TrustedSigning on every build (B-194).
 * The file's path and the signing values reach PowerShell through the environment, never through the command line.
 */
const { execFileSync } = require('node:child_process');

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Installed by passioncode-ai/.github actions/windows-signing in this job; missing means that step did not run.
  "Import-Module ArtifactSigning",
  "$p = @{ Endpoint = $env:AZURE_SIGNING_ENDPOINT; CodeSigningAccountName = $env:AZURE_SIGNING_ACCOUNT; CertificateProfileName = $env:AZURE_SIGNING_PROFILE",
  "  Files = $env:FABRIC_SIGN_FILE; FileDigest = 'SHA256'; TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'; TimestampDigest = 'SHA256'",
  "  ExcludeEnvironmentCredential = $true; ExcludeWorkloadIdentityCredential = $true; ExcludeManagedIdentityCredential = $true",
  "  ExcludeSharedTokenCacheCredential = $true; ExcludeVisualStudioCredential = $true; ExcludeVisualStudioCodeCredential = $true",
  "  ExcludeAzureCliCredential = $false; ExcludeAzurePowerShellCredential = $true; ExcludeAzureDeveloperCliCredential = $true",
  "  ExcludeInteractiveBrowserCredential = $true }",
  "Invoke-ArtifactSigning @p",
].join('\n');

const REQUIRED = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE'];

/** One signature per file: electron-builder calls once per hash, and only SHA-256 is asked for (signingHashAlgorithms). */
function sign(config, _packager, run = execFileSync, env = process.env) {
  if (config.hash !== 'sha256') return;
  const missing = REQUIRED.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`win-sign: ${missing.join(', ')} not set`);
  const options = { stdio: 'inherit', env: { ...env, FABRIC_SIGN_FILE: config.path } };
  // The signing service answers an occasional failure (B-190); one more try before the build stops.
  try { run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], options); }
  catch { run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], options); }
}

module.exports = sign;
module.exports.SCRIPT = SCRIPT;
