# Glow

A local web app for Philips Hue bridges, written in Go and using the Hue v2 API for lights, rooms and scenes. No Go dependencies or cloud account required; optional bridge discovery uses Philips' discovery service.

## Run

Install Go 1.21 or newer, then run:

```sh
go run .
```

Open **http://127.0.0.1:6002** on the same computer, or **http://YOUR-COMPUTER-IP:6002** from another device. Any hostname that resolves to the computer can also be used. Find the bridge automatically or enter its private IP, press its physical button, and connect within 30 seconds. The bridge and computer must be able to reach each other on the local network. A v2-capable, up-to-date Hue Bridge is required.

## Use

- Create or edit rooms to assign light devices. A device can belong to one room; remove it from its old room before adding it to another. Existing non-light room members are preserved.
- Controls appear only when a light reports the corresponding capability. Room power controls are shown when the bridge provides a grouped light.
- To create a scene, first set the room's lights to the desired states, then choose **Create scene**. Glow captures their current on/off, brightness and color or temperature. Recall and delete existing scenes from the Scenes page. Gradient/effect animation is not captured.
- Refresh to see changes made in other apps. Settings can disconnect the saved bridge without deleting bridge resources.

## Privacy and security

The app listens on `0.0.0.0:6002` without authentication or HTTPS and accepts any hostname. **Anyone who can reach the port can control the bridge or disconnect it**, and traffic between the browser and app is unencrypted. Accepting any hostname also leaves the app vulnerable to DNS rebinding, so a malicious website could potentially control it through your browser even without direct network access. Restrict access with your firewall and do not expose it to the internet. The bridge address and application key are stored in `huepc/config.json` under your OS user configuration directory. Protect your user account and configuration file. Hue bridges use self-signed TLS certificates, so the app does not verify the bridge certificate. Initial bridge registration uses the bridge's HTTP registration endpoint. Discovery sends a request to `discovery.meethue.com`; manual setup does not.

## Test

```sh
go test ./...
```
