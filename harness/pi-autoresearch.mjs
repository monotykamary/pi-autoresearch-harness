#!/usr/bin/env node

import { tsImport } from 'tsx/esm/api';

await tsImport(new URL('./cli.ts', import.meta.url).href, import.meta.url);
