# Signing and notarizing CloudPennies

CloudPennies builds fine without any of this. Unsigned builds work, but they come with warnings and, on macOS, without in-app updates. This guide explains how to turn signing on. Nothing in the code has to change: the release workflow signs when it finds the right repository secrets and builds unsigned when it does not.

Status of this guide: the build configuration was checked against the electron-builder 26 source, but the signed path has **not been run end to end** for this project (it needs a paid Apple account and a certificate). Apple and GitHub move their menus around; where a menu name below does not match what you see, look for the nearest equivalent.

## What users see

| | Unsigned (today) | Signed and notarized |
|---|---|---|
| macOS, first launch | Gatekeeper blocks the app. The user has to right-click → **Open**, or on recent macOS versions go to System Settings → Privacy & Security → **Open Anyway**. | Opens after the standard "downloaded from the Internet" confirmation. |
| macOS, updates | The app can tell that a new version exists but cannot install it (macOS only lets a signed app replace itself). It shows a link to the releases page. | The update downloads in the background; the user restarts to install. |
| Windows, first launch | SmartScreen shows "Windows protected your PC"; the user clicks **More info → Run anyway**. | See the Windows section: a certificate helps, but may not remove the warning immediately. |
| Windows and Linux AppImage, updates | Work without signing. | Work. |

## macOS

You need a Mac for the certificate steps (Keychain Access). The build itself runs on GitHub's macOS runners.

### 1. Join the Apple Developer Program

Enroll at <https://developer.apple.com/programs/>. It is a paid yearly membership, and approval can take from a few hours to several days. A free Apple ID is not enough: "Developer ID" certificates are only available to members. In an organization account, only the Account Holder can create Developer ID certificates.

### 2. Create a "Developer ID Application" certificate

1. On your Mac, open **Keychain Access**. In the menu bar choose **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**
2. Enter your email address and a name, leave "CA Email Address" empty, choose **Saved to disk**, and save the `.certSigningRequest` file.
3. Go to <https://developer.apple.com/account/resources/certificates/list> and click **+**.
4. Choose **Developer ID Application** (not "Developer ID Installer", not "Apple Distribution" and not "Mac App Distribution": those are for other purposes and will not work here). Continue. If you are asked to pick a profile type or intermediate certificate, the newer default (G2) is the right choice.
5. Upload the `.certSigningRequest` file, then **Download** the resulting `.cer` file.
6. Double-click the `.cer` file. It is added to your **login** keychain.

### 3. Export it as a .p12 file

1. In Keychain Access select the **login** keychain and the **My Certificates** category.
2. Find **Developer ID Application: Your Name (TEAMID)**. It must have a small arrow that expands to show a private key. If there is no private key, the certificate was created from a request made on another Mac; export it there instead.
3. Right-click the certificate → **Export…**, choose the format **Personal Information Exchange (.p12)**, and save it as `certificate.p12`.
4. Set a password when asked. You will need it as `CSC_KEY_PASSWORD`. (macOS may then ask for your login password to allow the export; that is a different password.)

Treat this file and its password like a key to your identity as a developer. Do not commit it.

### 4. Base64-encode the certificate

GitHub secrets are text, so the file has to be encoded. In Terminal:

```bash
base64 -i certificate.p12 | pbcopy
```

The encoded text is now on your clipboard. This becomes the `CSC_LINK` secret.

### 5. Create an app-specific password

Notarization signs in to Apple with your Apple ID, but not with your normal password.

1. Go to <https://account.apple.com> (formerly appleid.apple.com) and sign in with the Apple ID that belongs to the developer account.
2. Open **Sign-In and Security → App-Specific Passwords** and create one. Name it something like "CloudPennies notarization".
3. Copy the password (it looks like `abcd-efgh-ijkl-mnop`). It is shown only once.

Two-factor authentication must be on for the Apple ID; app-specific passwords do not exist without it.

### 6. Find your Team ID

Go to <https://developer.apple.com/account> and open **Membership details**. The Team ID is a 10-character code such as `A1B2C3D4E5`. It is also the code in brackets at the end of the certificate name.

### 7. Add the five repository secrets

On GitHub: the repository → **Settings → Secrets and variables → Actions → New repository secret**. Add each of these, with exactly these names:

| Secret name | Value |
|---|---|
| `CSC_LINK` | the base64 text from step 4 |
| `CSC_KEY_PASSWORD` | the `.p12` password from step 3 |
| `APPLE_ID` | the email address of your Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | the password from step 5 |
| `APPLE_TEAM_ID` | the Team ID from step 6 |

How the workflow reacts:

- No `CSC_LINK`: the macOS build is unsigned, as before. The other secrets are ignored.
- `CSC_LINK` set, but none of the three `APPLE_…` secrets: the app is signed but **not notarized**. Gatekeeper still blocks it. The build log says `skipped macOS notarization`.
- `CSC_LINK` set and only some of the `APPLE_…` secrets: the build fails with a message naming the missing one.
- All five: signed and notarized.

The workflow file must be the current one. If you maintain it by hand, copy `docs/github-workflows/release.yml` to `.github/workflows/release.yml`.

### 8. Push a tag

Set the new version in `package.json`, commit, then:

```bash
git tag v0.4.0
git push origin v0.4.0
```

The **Release** workflow builds all three platforms and attaches the files to the GitHub release. Notarization uploads the app to Apple and waits for the result. This usually takes a few minutes, but Apple gives no guarantee and the first submission from a new account can take much longer.

In the macOS job's "Build installers" log, look for `signing` followed by `notarization successful`.

The release must be **published** (not a draft, not a pre-release) and must include the `latest-mac.yml`, `latest-linux.yml`, `latest.yml` and `.blockmap` files that the workflow uploads. The in-app updater reads those. Do not rename or delete them, and keep the `-mac.zip` file: macOS updates are installed from the zip, not from the dmg.

### 9. Verify the result

Download the `.dmg` from the release on a Mac, open it, and drag CloudPennies to Applications. Then in Terminal:

```bash
spctl -a -vv /Applications/CloudPennies.app
```

Expected: `accepted`, `source=Notarized Developer ID`, and an `origin=Developer ID Application: …` line with your name. `rejected` means the app is unsigned or not notarized.

```bash
codesign -dv --verbose=4 /Applications/CloudPennies.app
```

Expected: `Authority=Developer ID Application: Your Name (TEAMID)`, your `TeamIdentifier`, and `flags=0x10000(runtime)`, which is the hardened runtime that notarization requires.

```bash
xcrun stapler validate /Applications/CloudPennies.app
```

Expected: `The validate action worked!` This means the notarization ticket is attached to the app, so it also opens on a Mac that is offline. (`xcrun` needs the Xcode command line tools: `xcode-select --install`.)

Only the app is signed and notarized, not the `.dmg` around it. That is electron-builder's default and is enough for Gatekeeper, which checks the app. Running `stapler validate` on the `.dmg` file itself is therefore expected to fail.

Finally, test the real thing: download the dmg with a browser on a Mac that has never run the app, and open it normally.

### Updates need two signed releases

An installed copy only updates itself if it is signed, and it only accepts an update signed by the same developer. So the first signed release still has to be installed by hand. In-app updates on macOS can be seen working from the second signed release on. This has not been tested for this project yet.

### If something goes wrong

- **The certificate expires.** Developer ID certificates are valid for several years. Apps signed before the expiry keep working; to sign new builds, create a new certificate and replace `CSC_LINK` and `CSC_KEY_PASSWORD`.
- **Notarization fails.** The log contains Apple's reason. Common ones are an Apple ID that has not accepted the latest agreement at developer.apple.com, a wrong Team ID, or an app-specific password that was revoked (changing the Apple ID password revokes all of them).
- **An alternative to the Apple ID password.** electron-builder also accepts an App Store Connect API key through `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, and recommends it. The workflow in this repository does not pass those variables; it would need a step that writes the key file to disk first.

## Windows

This part is shorter because it is less certain. The workflow supports the simplest case only, and it has not been tested with a real certificate.

**What a code-signing certificate is.** A certificate authority (for example DigiCert, Sectigo or SSL.com) verifies who you are and issues a certificate that puts your name on the installer. Windows then shows that name as the verified publisher instead of "Unknown publisher". There is no Windows equivalent of Apple's notarization.

**What this workflow supports.** A certificate that you hold as a password-protected `.pfx` / `.p12` file. Base64-encode it (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Clipboard`) and add two repository secrets:

| Secret name | Value |
|---|---|
| `WIN_CSC_LINK` | the base64 text of the `.pfx` file |
| `WIN_CSC_KEY_PASSWORD` | its password |

Without `WIN_CSC_LINK` the Windows build is unsigned, as before. The macOS secret `CSC_LINK` is deliberately not used for Windows.

**What it does not support.** Certificate authorities are now required to issue code-signing keys on hardware: a USB token, or a cloud HSM / cloud signing service. This applies to EV certificates and, since 2023, to standard (OV) ones as well. Such a certificate usually cannot be exported to a `.pfx` file at all, so the two secrets above cannot be used with it. Signing then needs a different setup, such as the vendor's cloud signing tool or Azure Trusted Signing (Azure Artifact Signing) wired into electron-builder's Windows signing options. That is not configured here. Before buying a certificate, check how the vendor expects you to sign from a CI system such as GitHub Actions.

**SmartScreen reputation.** Signing does not by itself remove the "Windows protected your PC" warning. SmartScreen builds reputation for a publisher and a file as more people download and run it, so a newly signed installer may still show the warning for a while. EV certificates used to be trusted immediately; Microsoft has changed this over time, so do not buy one for that reason without checking current behavior.

**Checking a signed installer.** Right-click the `.exe` → **Properties → Digital Signatures**. The tab should list your name, and **Details** should say the signature is OK.

**Updates on Windows** work with unsigned builds. Once a release is signed, the updater also checks that later installers carry the same publisher name, so keep signing with a certificate issued to the same name.

## Linux

Linux packages are not signed. The AppImage updates itself; the `.tar.gz` build shows a link to the releases page when a new version exists.

## Building signed on your own Mac

With the certificate in your login keychain, `npm run dist:mac` signs automatically. To notarize as well, set the three variables for that command:

```bash
APPLE_ID="you@example.com" APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop" APPLE_TEAM_ID="A1B2C3D4E5" npm run dist:mac
```

To force an unsigned build on a Mac that has a certificate:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```
