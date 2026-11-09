# Releasing Cobra

A release is a version tag. `.github/workflows/release.yml` builds every
file on its own kind of computer, signs what is signed, and makes a
**draft** release. You read the draft and publish it. Nothing goes out on
its own.

## One time: the secrets

Add each secret under the repository's Settings → Secrets and variables →
Actions. Never put one in a file in the repository.

### The desk's update key

The desk app installs an update only when its signature matches the
public key built into the app (`plugins.updater.pubkey` in
`apps/desk/app/src-tauri/tauri.conf.json`). The private key signs each
release.

| Secret | What |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | The private key file's text. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password. |

The key pair was made with `npx tauri signer generate` and is kept in
`~/.config/cobra-release/` (mode 600) on the computer that made it. To add
the secrets from there without showing them:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.config/cobra-release/updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD < ~/.config/cobra-release/updater.key.password
```

Keep a copy of that folder somewhere safe (a password manager). A lost
key means the desks already installed can never take an update again: each
person would have to install the desk again by hand. A new key pair means
the same.

### Apple (the macOS files)

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | Your **Developer ID Application** certificate and its private key, exported from Keychain Access as a `.p12`, then base64 (`base64 -i cert.p12 \| pbcopy`). |
| `APPLE_CERTIFICATE_PASSWORD` | The password you gave the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, as `security find-identity -v -p codesigning` shows it: `Developer ID Application: Your Name (TEAMID)`. |
| `APPLE_API_KEY` | An App Store Connect API key's ID (Users and Access → Integrations → App Store Connect API, role Developer). |
| `APPLE_API_ISSUER` | The issuer ID on that page. |
| `APPLE_API_KEY_P8` | The key's `.p8` file's text (downloadable once). |

The certificate: developer.apple.com → Certificates → **+** → Developer ID
Application. Make the request in Keychain Access on a Mac (Certificate
Assistant → Request a Certificate From a Certificate Authority), so the
private key stays in your keychain.

The Apple secrets are optional while Cobra goes to a small group of
testers. Without them a release still has its Mac files: the agent package
is unsigned and the desk app is ad-hoc signed, not notarized. The draft's
notes say so, and the testers open them by hand once (docs/mac-test.md,
"Opening an unsigned build"). Add the secrets before a public launch: the
same workflow then signs and notarizes with no other change.

## Each release

1. On a branch, set the one version everywhere and open a pull request:

   ```sh
   node scripts/release/version.ts set 0.4.0
   ```

2. When it has merged, tag `main` and push the tag:

   ```sh
   git checkout main && git pull --ff-only
   git tag v0.4.0 && git push origin v0.4.0
   ```

3. The Release workflow runs (about 30 minutes; notarizing is most of it).
   It makes a draft release with:
   - `cobra-agent-0.4.0-<target>.tar.gz` for linux-x64 and linux-arm64;
   - the desk: `.deb` and `.AppImage` (x64 and arm64) and the signed
     update files;

   For now a release is Linux only. The macOS rows (agent darwin-arm64 and
   darwin-x64, desk universal `.dmg`) come back to `release.yml` when macOS
   has been tested on a Mac.
   - `latest.json` (the desk's update feed) and `SHA256SUMS`;
   - a GitHub attestation for every file, once the repository is public
     (`gh attestation verify <file> -R <owner>/cobra`).
4. Read the draft's notes, then publish it. The desks find it under
   Settings → This app → Updates.

## Checking a file by hand

```sh
sha256sum --check --ignore-missing SHA256SUMS       # shasum -a 256 -c on macOS
gh attestation verify cobra-agent-0.4.0-linux-x64.tar.gz -R <owner>/cobra
codesign --verify --deep --strict --verbose=2 /Applications/Cobra.app   # macOS
spctl --assess --type execute --verbose /Applications/Cobra.app         # "accepted, source=Notarized Developer ID"
```
