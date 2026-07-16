#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const repoPath = path.resolve(process.argv[2] ?? ".");
const chatCount = readPositiveInteger("GARCON_SEARCH_BENCH_CHATS", 3_000);
const messagesPerChat = readPositiveInteger("GARCON_SEARCH_BENCH_MESSAGES", 40);
const warmupIterations = readPositiveInteger("GARCON_SEARCH_BENCH_WARMUPS", 8);
const measuredIterations = readPositiveInteger(
  "GARCON_SEARCH_BENCH_ITERATIONS",
  80,
);
const moduleUrl = pathToFileURL(
  path.join(repoPath, "server/chats/chat-search-index.ts"),
).href;
const { ChatSearchIndex } = await import(moduleUrl);
const benchmarkDir = await mkdtemp(
  path.join(os.tmpdir(), "garcon-search-benchmark-"),
);
const dbPath = path.join(benchmarkDir, "search.sqlite");

const allowedChatIds = Array.from(
  { length: chatCount },
  (_, chatIndex) => `chat-${chatIndex}`,
);
const workloads = [
  { name: "common", query: "commonterm" },
  { name: "rare", query: "rareterm" },
  { name: "cross-message", query: "alphaterm betaterm" },
];
let index;

try {
  index = new ChatSearchIndex({
    dbPath,
    registry: { listAllChats: () => ({}) },
    loadNativeMessages: async () => [],
    now: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  await index.init();

  const indexingStarted = performance.now();
  for (let chatIndex = 0; chatIndex < chatCount; chatIndex += 1) {
    index.replaceMessages(`chat-${chatIndex}`, messagesForChat(chatIndex), {
      sourceKey: "benchmark",
    });
  }
  const indexingMs = performance.now() - indexingStarted;

  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    for (const workload of workloads) runSearch(workload.query);
  }

  const results = workloads.map((workload) => measureWorkload(workload));
  console.log(
    JSON.stringify(
      {
        repoPath,
        chatCount,
        messagesPerChat,
        indexedMessages: chatCount * messagesPerChat,
        indexingMs,
        warmupIterations,
        measuredIterations,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  if (!index || typeof index.close === "function") {
    index?.close();
    await rm(benchmarkDir, { recursive: true, force: true });
  } else {
    deferCleanupUntilExit(benchmarkDir);
  }
}

function messagesForChat(chatIndex) {
  return Array.from({ length: messagesPerChat }, (_, messageIndex) => {
    const terms = [
      "commonterm",
      `chatword${chatIndex % 97}`,
      `messageword${messageIndex % 31}`,
    ];
    if (chatIndex % 50 === 0 && messageIndex === 0) terms.push("rareterm");
    if (chatIndex % 10 === 0 && messageIndex === 1) terms.push("alphaterm");
    if (chatIndex % 10 === 0 && messageIndex === 2) terms.push("betaterm");
    return {
      type: messageIndex % 2 === 0 ? "user-message" : "assistant-message",
      timestamp: `2026-07-16T00:${String(messageIndex % 60).padStart(2, "0")}:00.000Z`,
      content: `${terms.join(" ")} synthetic transcript payload ${"context ".repeat(12)}`,
    };
  });
}

function runSearch(query) {
  return index.search({ query, allowedChatIds, limit: 20 });
}

function measureWorkload(workload) {
  const samples = [];
  let resultCount = 0;
  for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
    const started = performance.now();
    const result = runSearch(workload.query);
    samples.push(performance.now() - started);
    resultCount = result.results.length;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    name: workload.name,
    resultCount,
    meanMs:
      samples.reduce((total, sample) => total + sample, 0) / samples.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

function percentile(sorted, fraction) {
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function deferCleanupUntilExit(directory) {
  // Defers deletion for comparison targets that predate the explicit close lifecycle.
  const cleaner = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        import { rm } from "node:fs/promises";
        const [parentPidValue, directory] = process.argv.slice(1);
        const parentPid = Number(parentPidValue);
        while (true) {
          try {
            process.kill(parentPid, 0);
          } catch {
            break;
          }
          await Bun.sleep(50);
        }
        await rm(directory, { recursive: true, force: true });
      `,
      String(process.pid),
      directory,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  cleaner.unref();
}
