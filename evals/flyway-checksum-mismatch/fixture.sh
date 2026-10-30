#!/usr/bin/env bash
set -euo pipefail

git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p sql
printf 'flyway.url=jdbc:postgresql://localhost/app\nflyway.locations=filesystem:sql\n' > flyway.conf
printf 'CREATE TABLE accounts (id int);\n' > sql/V11__accounts.sql
printf 'ALTER TABLE accounts ADD COLUMN emial text;\n' > sql/V12__accounts_email.sql
git add -A && git commit -q -m "V11, V12"
git checkout -q -b fix-typo
printf 'ALTER TABLE accounts ADD COLUMN email text;\n' > sql/V12__accounts_email.sql
git add -A && git commit -q -m "fix typo in V12"
