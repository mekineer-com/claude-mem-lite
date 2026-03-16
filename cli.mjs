#!/usr/bin/env node
import { main } from './install.mjs';

await main(process.argv.slice(2));
