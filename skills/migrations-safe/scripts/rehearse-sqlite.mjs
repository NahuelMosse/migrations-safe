#!/usr/bin/env node
// Rehearses SQLite migrations on a throwaway copy of a database. Usage and options: `rehearse-sqlite.mjs --help`.
import { runRehearseCli } from './lib/rehearse-cli.mjs';

process.exitCode = await runRehearseCli(process.argv.slice(2));
