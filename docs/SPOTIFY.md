# Spotify display

Version 0.2.6 adds a read-only now-playing mode for the 960×376 WTR MAX panel.
Since 0.2.7 the layout follows Nocturne's now-playing screen without its
controls: rounded album artwork, a bold track title, the artist in 60% white,
a pill-shaped timeline with elapsed and total time, and a four-point mesh
gradient taken from the artwork colors. Nocturne is a visual reference, not a code,
firmware, asset, or service dependency.

This is a display, not a Spotify player. It does not play audio or provide
play/pause, seek, skip, volume, playlist, or touch controls. Continue listening
and controlling playback on your usual Spotify device.

## Requirements

- Install/update OLED Studio using the existing Proxmox installer, then open its
  web UI from a computer on the trusted LAN.
- The service host needs outbound HTTPS access to Spotify's account/API services
  and `i.scdn.co` for artwork. The browser used to sign in also needs internet access.
- Create your own Spotify Web API app in the
  [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
  Check Spotify's current [development-mode requirements and user allowlist](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
  for that app/account: the app owner currently needs Spotify Premium, and users
  must be allowlisted. This feature has not been verified with a real Premium
  Basic account; do not treat the sample preview as an account-eligibility test.

Only a Client ID is required. Do not enter a Client Secret. A public domain,
Nocturne subscription, and inbound port forwarding are not required.

## Connect an account

1. In the Spotify app settings, register this Redirect URI exactly:

   ```text
   http://127.0.0.1:17879/callback
   ```

   Do not substitute the Proxmox LAN address or `localhost`. This is the
   loopback address of the computer running your browser, not the Proxmox host.
2. Open the **Spotify** tab, enter the app's **Client ID**, and select
   **Prepare Spotify sign-in**.
3. Open **Sign in with Spotify** and approve the read-only
   `user-read-currently-playing` permission. The flow uses authorization code
   with PKCE; no playback-control scope is requested.
4. After approval, the browser may show **connection refused** at the loopback
   address. This is expected: OLED Studio does not run a callback listener.
   Copy the complete address from the address bar, including `code` and `state`.
5. Return to OLED Studio, paste that URL into **Returned address**, and select
   **Finish connection** within ten minutes. The field is masked, but the URL
   contains a one-time authorization code: do not share, log, or screenshot it.
   If the attempt expires, fails, or the service restarts, begin again at step 2.
6. Once connected, select **Show on panel**. This powers the panel on and starts
   server-side updates. Start music on your normal Spotify device; a change may
   take until the next poll to appear.

See Spotify's [redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
and [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
for the platform-side setup.

## Display behavior

- While enabled, the service normally queries Spotify about every 15 seconds;
  track changes are not instant. The timeline is estimated locally between
  successful polls and stops advancing for paused playback.
- The renderer waits about one second between cycles. API requests, rendering,
  and serial transfers add latency; this is not a guarantee of exactly one
  physical-panel frame per second.
- Closing the browser does not stop the display. The enabled preference is
  saved, so service restart/reboot resumes it when credentials, network access,
  and the panel are available.
- **Stop display** disables Spotify updates but does not power off the panel;
  the last frame can remain visible. Use **Off** to turn the screen off.
- Sending a different frame/image/GIF, sending display On/Off, or stopping the
  current display job disables the saved Spotify mode. Brightness changes do
  not. Merely navigating to another tab is not itself a new frame submission.
- Paused, empty, disconnected, and error states are shown explicitly. Network
  failures and rate limits delay retries; an authorization failure may require
  connecting the account again. A cached track is not proof of a fresh API poll.

If saving the disabled preference fails, Spotify updates still stop in memory
and manual display/Off commands continue. The status reports a storage warning:
the old enabled preference may survive on disk and resume after restart. Repair
the state-directory issue before relying on the persisted disabled state.

**Preview sample layout** shows a fictional local sample in the web preview.
It requires no Spotify login and never sends that sample to the physical panel.
Use **Return to live preview** to inspect the server-rendered current state.

## Credentials and persistent state

On the packaged Linux service, state is stored at:

```text
/var/lib/asterctl-web/spotify.json
```

The file contains the Client ID, refresh token, and enabled preference. The
systemd unit uses `StateDirectory=asterctl-web` with mode `0700`; the token file
is written with mode `0600`. This persistent directory is separate from the
temporary YouTube files under `/run/asterctl-web`.

Access tokens and pending PKCE data stay in server memory. Token values are not
returned by the status API or stored in browser local storage. The refresh token
is not encrypted at rest: the service user, root, and anyone able to read a
backup of the file can access it. Do not commit it or attach it to bug reports.

For custom/development runs, `ASTERCTL_STATE_DIR` overrides the state directory.
Without an override, Linux uses `/var/lib/asterctl-web`; other platforms use
`.asterctl-state` relative to the process working directory.

**Disconnect and remove saved credentials** stops this display mode and clears
the locally saved credentials. It does not erase earlier backups or revoke the
app's authorization on Spotify. Remove the app from your Spotify account's
connected apps separately if you also want to revoke that authorization.

## Network and privacy boundary

The OLED Studio web UI/API has no user authentication. Spotify OAuth connects
an account; it does not add a login gate to the web UI. Anyone who can reach the
service can view now-playing information, change the connection, or control the
panel. Bind to the intended private LAN address and restrict access with the
host/network firewall. Do not expose port 8787 through public port forwarding
or a public tunnel.

The default LAN UI uses HTTP, so the returned authorization URL is sent from
your browser to the service without transport encryption. Use only a trusted
network; use an authenticated HTTPS reverse proxy or trusted encrypted network
if that boundary is insufficient.

## Troubleshooting and verification

- **Redirect mismatch:** compare the registered URI exactly, including scheme,
  numeric loopback host, port, and `/callback` path.
- **Invalid/expired return URL:** prepare a new sign-in and paste the entire
  newly returned address within ten minutes. A newer sign-in replaces the old
  pending attempt; a failed completion also requires a new attempt.
- **Account/API access error:** check the app's development-mode requirements
  and allowed users in Spotify's dashboard. An account subscription name alone
  does not prove that this specific app can access the API.
- **No current track:** start music on an active Spotify device and wait for a
  poll. The OLED panel does not become an audio playback device.
- **State-file permissions:** the service user needs private access to its
  state directory. Do not solve this by making tokens readable by other users.
- **Offline/rate limited:** check outbound connectivity and allow retries;
  repeatedly reconnecting is not a remedy for rate limiting.

Real Spotify-account authorization (including Premium Basic) and physical
WTR MAX output have not been verified as part of adding this feature. Local
samples, fixtures, simulation, and automated tests verify different layers.
After setup, check real track changes, pause/resume, browser-close behavior,
service restart, and replacing Spotify with Off or another display mode.
