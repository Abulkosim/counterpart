# Security

Counterpart is experimental. The message encryption is built from standard parts (HPKE, Ed25519) but the way they are combined is ours and has not been independently reviewed. There is no forward secrecy yet: if a device key leaks, recorded messages to that device can be read.

Report problems privately through GitHub security advisories on this repository. Please do not open a public issue for a vulnerability.
