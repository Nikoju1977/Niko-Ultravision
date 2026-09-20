#!/usr/bin/env node
import { readFileSync } from "node:fs";

const meta = JSON.parse(readFileSync(new URL("../src/app-meta.json", import.meta.url), "utf8"));
const required = ["og_title", "og_description", "favicon_url", "marketplace_cover_url"];
const missing = required.filter((key) => typeof meta[key] !== "string" || meta[key].trim() === "");
if (missing.length) throw new Error(`Missing app metadata: ${missing.join(", ")}`);
console.log("UltraVision adaptation metadata is complete.");
