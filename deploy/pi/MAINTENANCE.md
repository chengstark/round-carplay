# Wi-Fi and v3 updates

## Normal Wi-Fi chooser

Open Settings → Wi-Fi, choose a network, and enter its password once. Networks
already saved by NetworkManager are marked **Saved**; leave the password blank
to reconnect, or enter a replacement password. The current network can also be
selected to reconnect. Passwords travel to the privileged helper through stdin
and stay in NetworkManager's protected profiles, outside application releases.

A switch stops the current PlayPort host, joins the chosen network, saves the
new Wi-Fi/address information privately and starts PlayPort again. The local
dashboard stays available. If joining fails, the helper attempts to restore the
previous profile. NetworkManager address-change events refresh PlayPort's bind
address and Wi-Fi handoff settings. A timer checks the saved connection every
45 seconds and attempts reconnection if it is down. Wi-Fi power saving is
disabled in the active profile and driver.

This feature chooses existing Wi-Fi networks. It does not create a Pi hotspot.

## Update-button behavior

Settings → System → **Check for updates** fetches the signed v3 channel feed,
downloads its prebuilt Linux ARM64 package, verifies the signature/checksum,
and tests the candidate backend before activation. The Pi runs no Git, npm,
Gradle or compiler during these updates. Applying an update restarts the kiosk,
backend and PlayPort host; the screen reconnects automatically.

The device checks automatically two minutes after backend startup and then
every six hours. An available update waits while CarPlay is active and retries
in five minutes; unavailable internet/feed failures retry in fifteen minutes.
The Apply service checks again for an active phone before an automatic switch.
Manual Update is allowed during a session after the on-screen restart notice.

The previous release remains installed. If the updated backend/host fail their
health checks, it is restored and services restart. An interrupted activation
is restored before app services start on the next boot. A failed version is
not installed repeatedly by the automatic checker; manual retry is available.
Wi-Fi credentials, accessory identity, phone pairing state and brightness
credentials live outside releases and are preserved.

Health checks establish service startup, not complete video/touch/audio
correctness. Keep a known-good release until physical testing is complete.

## GitHub build and publication

Repository: `chengstark/round-carplay`; v3 branch: `browser-kiosk`.
The dedicated `.github/workflows/pi-v3.yml` workflow builds the dashboard and
our current PlayPort source on a Linux ARM64 runner. It publishes an immutable
package and then advances this dedicated signed feed:

`https://github.com/chengstark/round-carplay/releases/download/pi-v3-channel/pi-v3.json`

The earlier Electron release workflow is not used. Full PlayPort sources needed
by CI are captured in `vendor/playport-source.tar.gz`, with upstream revision,
snapshot checksum and licence. The snapshot includes our current local host
changes. It contains no identity, build outputs, network password or pairing
state. Refresh it whenever the active PlayPort source changes:

```sh
node scripts/snapshot-playport.mjs /path/to/current/playport
```

The build uses the tracked npm lockfile. Package signatures use Ed25519; the
Pi's public key and feed URL are provisioned by `deploy/pi/pi-update.json`.
The matching private key was generated locally at `dist/pi-signing/private.pem`
with mode 0600. That directory is ignored by Git and must not be published.

Before the first hosted build, an owner must provision the GitHub Actions
secret **PI_UPDATE_SIGNING_KEY** from that private key, and publish the reviewed
current sources to `browser-kiosk`. Do not print the key into terminal/chat logs.
For an authenticated owner, the setup command is:

```sh
gh secret set PI_UPDATE_SIGNING_KEY --repo chengstark/round-carplay < dist/pi-signing/private.pem
```

The public repository will receive source code and compiled update packages.
Private installation archives named `*-PRIVATE.tar.gz` are **not** release
artifacts and must never be uploaded. The OTA packager copies only dashboard,
host distribution, public deployment helpers and release metadata.

## One-time activation on the existing Pi

The first deployment predates these root-owned network/update helpers. Install
a newly built **private bootstrap bundle** using `deploy/install.sh` once and
reboot. This provisions the helpers, NetworkManager dispatcher/reconnect timer,
public signing key and update recovery units. Thereafter the Update button can
install app/host releases without a Mac or SD-card rewrite.

Root maintenance-helper changes and public-key rotation require another base
installer run. Application releases never execute a downloaded installer as
root. Ordinary app/host updates use the installed fixed maintenance service.

Validation in this chat covers mocked Wi-Fi join/restore, signed-feed rejection,
download integrity, idle deferral, candidate failure and rollback/interrupted
activation. Physical Wi-Fi switching, the GitHub-hosted build and the first
device OTA apply still require validation after network access is restored and
the reviewed branch/signing secret are published.
