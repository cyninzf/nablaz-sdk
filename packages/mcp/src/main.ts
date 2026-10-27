#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// stdio entry point. The reader URL comes from --reader-url or NABLAZ_READER_URL, default the local reader.
// stdout carries the protocol; nothing else is written to it.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_READER_URL, readServer } from "./server.ts";

const flag = process.argv.indexOf("--reader-url");
const readerUrl = (flag >= 0 ? process.argv[flag + 1] : undefined) ?? process.env.NABLAZ_READER_URL ?? DEFAULT_READER_URL;

await readServer({ readerUrl }).connect(new StdioServerTransport());
console.error(`nablaz-read MCP server on stdio, reader ${readerUrl}`);
