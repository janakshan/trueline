#!/usr/bin/env node
// Copies the generated sample documents into local storage so the seeded rows
// have real bytes behind them. Without this the review preview 404s and the
// demo looks broken on the very first click.
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

const dir = process.env.STORAGE_DIR ?? ".storage";
await mkdir(join(dir, "samples"), { recursive: true });
await cp("samples", join(dir, "samples"), { recursive: true });
console.log(`copied samples -> ${join(dir, "samples")}`);
