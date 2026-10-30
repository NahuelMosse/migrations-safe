#!/usr/bin/env bash
set -euo pipefail

git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p db/migrations
printf 'CREATE TABLE users (id int);\n' > db/migrations/0041_users.sql
git add -A && git commit -q -m "users"
git checkout -q -b feature
printf 'CREATE TABLE invoices (id int);\n' > db/migrations/0042_invoices.sql
git add -A && git commit -q -m "invoices"
git checkout -q main
printf 'CREATE TABLE payments (id int);\n' > db/migrations/0042_payments.sql
git add -A && git commit -q -m "payments"
git checkout -q feature
git merge -q main --no-edit
