# Security

This is a trusted local development tool. It binds only to loopback, validates Host and browser Origin, and uses per-run tokens for agent tools. It is not a multi-user service and must not be publicly exposed.

Process termination is limited to directly managed children; subprocess descendants are outside its scope. Upstream proxy experiments can cause real effects on the explicitly configured service. Use disposable data and sandbox services. Never include secrets in operation identifiers, which are persisted and exported.

When reporting a vulnerability, provide a minimal reproduction with dummy credentials. Do not include personal data, real tokens, or live upstream URLs.
