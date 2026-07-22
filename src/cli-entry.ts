#!/usr/bin/env node
// npm bin entry for the bool-sdk CLI (package.json "bin"). All logic lives in
// cli.ts so tests can drive it with stubbed deps.
import { runCli } from "./cli.js";

process.exit(await runCli(process.argv.slice(2)));
