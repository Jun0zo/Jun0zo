import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"

import { buildImageArguments, parseUsage } from "./update-openusage-card.mjs"

const SNAPSHOTS = [
  {
    providerId: "codex",
    displayName: "Codex",
    fetchedAt: "2026-08-31T03:55:38.100Z",
    lines: [
      { type: "text", label: "Last 30 Days", value: "$100.25 · 2.0B tokens" },
      {
        type: "barChart",
        label: "Usage Trend",
        points: [
          { label: "Aug 29", value: 500_000_000 },
          { label: "Aug 30", value: 700_000_000 },
          { label: "Aug 31", value: 800_000_000 },
        ],
      },
    ],
  },
  {
    providerId: "claude",
    displayName: "Claude",
    fetchedAt: "2026-08-31T03:55:33.556Z",
    lines: [
      { type: "text", label: "Last 30 Days", value: "$25.25 · 1.5B tokens" },
      {
        type: "barChart",
        label: "Usage Trend",
        points: [
          { label: "Aug 29", value: 500_000_000 },
          { label: "Aug 30", value: 500_000_000 },
          { label: "Aug 31", value: 500_000_000 },
        ],
      },
    ],
  },
]

test("aggregates official OpenUsage provider snapshots", () => {
  // Given
  const apiResponse = structuredClone(SNAPSHOTS)

  // When
  const activity = parseUsage(apiResponse)

  // Then
  assert.equal(activity.totalCostUsd, 125.5)
  assert.equal(activity.totalTokens, 3_500_000_000)
  assert.deepEqual(activity.dailyTokens, [1_000_000_000, 1_200_000_000, 1_300_000_000])
  assert.deepEqual(
    activity.providers.map(({ id, costUsd }) => ({ id, costUsd })),
    [
      { id: "codex", costUsd: 100.25 },
      { id: "claude", costUsd: 25.25 },
    ],
  )
})

test("keeps provider order and image colors stable regardless of API order", () => {
  // Given
  const apiResponse = structuredClone(SNAPSHOTS).reverse()

  // When
  const arguments_ = buildImageArguments(parseUsage(apiResponse), "card.png")
  const drawing = arguments_.join(" ")

  // Then
  assert.ok(drawing.indexOf("Codex") < drawing.indexOf("Claude"))
  assert.match(drawing, /#19ad8c.*Codex/)
  assert.match(drawing, /#e8785b.*Claude/)
})

test("builds a PNG command from parsed OpenUsage data", () => {
  // Given
  const activity = parseUsage(structuredClone(SNAPSHOTS))

  // When
  const arguments_ = buildImageArguments(activity, "card.png")
  const drawing = arguments_.join(" ")

  // Then
  assert.match(drawing, /\$125\.50/)
  assert.match(drawing, /3\.50B tokens/)
  assert.match(drawing, /Codex/)
  assert.match(drawing, /\$100\.25/)
  assert.equal(arguments_.at(-1), "card.png")
})

test("writes a card by reading the OpenUsage HTTP API", async () => {
  // Given
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(SNAPSHOTS))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.equal(typeof address, "object")
  assert.notEqual(address, null)
  const outputDirectory = await mkdtemp(join(tmpdir(), "openusage-card-"))
  const outputPath = join(outputDirectory, "card.png")

  // When
  const exitCode = await new Promise((resolve, reject) => {
    if (typeof address !== "object" || address === null) {
      reject(new TypeError("Expected a TCP server address"))
      return
    }
    const child = spawn(process.execPath, ["scripts/update-openusage-card.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        OPENUSAGE_API_URL: "http://127.0.0.1:" + address.port + "/v1/usage",
        OPENUSAGE_CARD_OUTPUT: outputPath,
      },
      stdio: "pipe",
    })
    child.once("error", reject)
    child.once("exit", resolve)
  })
  server.close()

  // Then
  assert.equal(exitCode, 0)
  const image = await readFile(outputPath)
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
})
