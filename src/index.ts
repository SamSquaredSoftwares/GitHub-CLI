#!/usr/bin/env node
import { execute } from './cli.js';

// Set rather than call process.exit() so buffered stdout is flushed first.
process.exitCode = await execute({ argv: process.argv.slice(2) });
