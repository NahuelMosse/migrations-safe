# Security policy

## Supported versions

Only the latest version published on npm (`latest`) receives fixes.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.
Include the version, the command you ran and what it did. You get an answer within 7 days.

migrations-safe reads migration files and, to rehearse, runs them in a throwaway Docker container with no outside network.
A way to make it run a command on the host, write outside its working and temp directories, reach the network from a
rehearsal container, or leave a container behind holding data counts as a vulnerability.
