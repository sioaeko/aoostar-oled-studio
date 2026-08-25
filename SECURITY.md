# Security

AOOSTAR OLED Studio is designed for a trusted private LAN. The web API does
not currently provide authentication. The Proxmox installer therefore accepts
only an IPv4 address already assigned to the host in an RFC1918 private range.

Do not expose TCP port 8787 through router port forwarding, a public reverse
proxy, or an unauthenticated tunnel. On shared or untrusted networks, restrict
the port with the Proxmox firewall or place the service behind an authenticated
proxy or VPN.

Please report security issues privately through GitHub's security-advisory
feature instead of opening a public issue.
