#!/usr/bin/env node

import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"

const API_URL = process.env.OPENUSAGE_API_URL ?? "http://127.0.0.1:6736/v1/usage"
const OUTPUT_PATH = process.env.OPENUSAGE_CARD_OUTPUT ?? "cards/openusage-last30.png"
const PROVIDER_COLORS = {
  codex: "#19ad8c",
  claude: "#e8785b",
  opencode: "#5ea8ff",
}
const FALLBACK_COLOR = "#c084fc"

class OpenUsageDataError extends Error {
  constructor(message) {
    super(message)
    this.name = "OpenUsageDataError"
  }
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

const parseSpend = (value) => {
  const match = /^\$([\d,]+(?:\.\d{1,2})?)\s*·\s*([\d.]+)([KMBT]?)\s+tokens$/.exec(value)
  if (match === null) throw new OpenUsageDataError("Unsupported Last 30 Days value: " + value)
  const [, costText, tokenText, tokenUnit] = match
  if (costText === undefined || tokenText === undefined || tokenUnit === undefined) {
    throw new OpenUsageDataError("Incomplete Last 30 Days value")
  }
  const multiplier = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[tokenUnit]
  if (multiplier === undefined) throw new OpenUsageDataError("Unsupported token unit: " + tokenUnit)
  return {
    costUsd: Number(costText.replaceAll(",", "")),
    formattedTokens: Number(tokenText) * multiplier,
  }
}

const findLine = (lines, type, label) =>
  lines.find((line) => isRecord(line) && line.type === type && line.label === label)

const parseProvider = (snapshot) => {
  if (!isRecord(snapshot) || typeof snapshot.providerId !== "string") {
    throw new OpenUsageDataError("Provider snapshot is missing providerId")
  }
  if (typeof snapshot.displayName !== "string" || typeof snapshot.fetchedAt !== "string") {
    throw new OpenUsageDataError("Provider " + snapshot.providerId + " has invalid metadata")
  }
  if (!Array.isArray(snapshot.lines)) {
    throw new OpenUsageDataError("Provider " + snapshot.providerId + " has no lines")
  }
  const spendLine = findLine(snapshot.lines, "text", "Last 30 Days")
  const trendLine = findLine(snapshot.lines, "barChart", "Usage Trend")
  if (spendLine === undefined || typeof spendLine.value !== "string") return null
  if (trendLine === undefined || !Array.isArray(trendLine.points)) return null

  const spend = parseSpend(spendLine.value)
  const dailyTokens = trendLine.points.map((point) => {
    if (!isRecord(point) || typeof point.value !== "number" || !Number.isFinite(point.value)) {
      throw new OpenUsageDataError("Provider " + snapshot.providerId + " has an invalid trend point")
    }
    return point.value
  })
  return {
    id: snapshot.providerId,
    name: snapshot.displayName,
    costUsd: spend.costUsd,
    tokens: spend.formattedTokens,
    dailyTokens,
    fetchedAt: snapshot.fetchedAt,
  }
}

export const parseUsage = (input) => {
  if (!Array.isArray(input)) throw new OpenUsageDataError("OpenUsage /v1/usage must return an array")
  const providerOrder = ["codex", "claude", "opencode"]
  const providers = input
    .map(parseProvider)
    .filter((provider) => provider !== null)
    .sort((left, right) => {
      const leftIndex = providerOrder.indexOf(left.id)
      const rightIndex = providerOrder.indexOf(right.id)
      return (leftIndex === -1 ? providerOrder.length : leftIndex) -
        (rightIndex === -1 ? providerOrder.length : rightIndex)
    })
  if (providers.length === 0) throw new OpenUsageDataError("No providers expose Last 30 Days usage")

  const dayCount = Math.max(...providers.map(({ dailyTokens }) => dailyTokens.length))
  const dailyTokens = Array.from({ length: dayCount }, (_, index) =>
    providers.reduce((sum, provider) => sum + (provider.dailyTokens[index] ?? 0), 0),
  ).slice(-30)
  return {
    providers,
    totalCostUsd: providers.reduce((sum, provider) => sum + provider.costUsd, 0),
    totalTokens: providers.reduce((sum, provider) => sum + provider.tokens, 0),
    dailyTokens,
    activeDays: dailyTokens.filter((value) => value > 0).length,
    refreshedAt: providers.map(({ fetchedAt }) => fetchedAt).sort().at(-1) ?? "",
  }
}

const formatCompact = (value) => {
  if (value >= 1e12) return (value / 1e12).toFixed(2) + "T"
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B"
  if (value >= 1e6) return (value / 1e6).toFixed(1) + "M"
  if (value >= 1e3) return (value / 1e3).toFixed(1) + "K"
  return value.toFixed(0)
}

const formatMoney = (value) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)

const providerColor = (providerId) => PROVIDER_COLORS[providerId] ?? FALLBACK_COLOR

const mvgText = (x, y, text) =>
  "text " + x + "," + y + " '" + text.replaceAll("'", "\\'") + "'"

const draw = (commands) => ["-draw", commands.join(" ")]

const polarPoint = (centerX, centerY, radius, angle) => {
  const radians = ((angle - 90) * Math.PI) / 180
  return [centerX + radius * Math.cos(radians), centerY + radius * Math.sin(radians)]
}

const arcPath = (centerX, centerY, radius, startAngle, endAngle) => {
  const [startX, startY] = polarPoint(centerX, centerY, radius, endAngle)
  const [endX, endY] = polarPoint(centerX, centerY, radius, startAngle)
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1
  return "path 'M " + startX + "," + startY + " A " + radius + "," + radius +
    " 0 " + largeArc + " 0 " + endX + "," + endY + "'"
}

export const buildImageArguments = (activity, outputPath) => {
  const spending = activity.providers.filter(({ costUsd }) => costUsd > 0)
  const spendingTotal = Math.max(spending.reduce((sum, provider) => sum + provider.costUsd, 0), 1)
  const codex = activity.providers.find(({ id }) => id === "codex")
  const codexShare = codex === undefined ? 0 : codex.costUsd / spendingTotal
  const maximum = Math.max(...activity.dailyTokens, 1)
  const chartWidth = 410
  const columnWidth = chartWidth / Math.max(activity.dailyTokens.length, 1)
  const bars = activity.dailyTokens.map((value, index) => {
    const height = Math.max(2, Math.round((value / maximum) * 90))
    const x = 382 + index * columnWidth
    return "roundrectangle " + x + "," + (286 - height) + " " +
      (x + Math.max(3, columnWidth - 3)) + ",286 2,2"
  })
  const providerRows = activity.providers.slice(0, 4).flatMap((provider, index) => {
    const y = 205 + index * 30
    const detail = provider.costUsd > 0
      ? formatMoney(provider.costUsd)
      : formatCompact(provider.tokens) + " tokens"
    return [
      "-fill", providerColor(provider.id), ...draw(["circle 190," + (y - 5) + " 195," + (y - 5)]),
      "-fill", "#e4e4e7", "-pointsize", "13", "-weight", "600", ...draw([mvgText(205, y, provider.name)]),
      "-fill", "#a1a1aa", "-pointsize", "12", "-weight", "600", ...draw([mvgText(274, y, detail)]),
    ]
  })
  return [
    "-size", "846x360", "xc:#18181a", "-font", "Arial",
    "-stroke", "#343438", "-strokewidth", "1", "-fill", "none",
    ...draw(["roundrectangle 0.5,0.5 845.5,359.5 14,14", "line 28,66 818,66", "line 342,88 342,314", "line 28,326 818,326"]),
    "-stroke", "none", "-fill", "#f4f4f5", "-pointsize", "18", "-weight", "700",
    ...draw([mvgText(48, 35, "OpenUsage Snapshot")]),
    "-fill", "#71717a", "-pointsize", "11", "-weight", "500",
    ...draw([mvgText(705, 27, "@JUN0ZO"), mvgText(642, 46, "LAST 30 DAYS · " + activity.refreshedAt.slice(0, 10))]),
    "-fill", "#8b8b94", "-pointsize", "10", "-weight", "700",
    ...draw([mvgText(28, 92, "API-EQUIVALENT ESTIMATE"), mvgText(382, 92, "DAILY TOKEN ACTIVITY")]),
    "-fill", "#f4f4f5", "-pointsize", "42", "-weight", "700",
    ...draw([mvgText(28, 139, formatMoney(activity.totalCostUsd))]),
    "-fill", "#a1a1aa", "-pointsize", "13", "-weight", "500",
    ...draw([mvgText(28, 164, formatCompact(activity.totalTokens) + " tokens · " + activity.activeDays + "/" + activity.dailyTokens.length + " active days")]),
    "-fill", "none", "-stroke", "#303034", "-strokewidth", "18",
    ...draw(["circle 100,237 100,187"]),
    "-stroke", "#19ad8c", ...draw([arcPath(100, 237, 50, 0, Math.max(0.1, codexShare * 359.8))]),
    "-stroke", "#e8785b", ...draw([arcPath(100, 237, 50, codexShare * 360, 359.9)]),
    "-stroke", "none", "-fill", "#f4f4f5", "-pointsize", "16", "-weight", "700",
    ...draw([mvgText(74, 237, (codexShare * 100).toFixed(1) + "%")]),
    "-fill", "#71717a", "-pointsize", "9", "-weight", "500", ...draw([mvgText(77, 253, "CODEX")]),
    ...providerRows,
    "-fill", "#d4d4d8", "-pointsize", "12", "-weight", "600", ...draw([mvgText(382, 128, "Latest")]),
    "-fill", "#a1a1aa", ...draw([mvgText(704, 128, formatCompact(activity.dailyTokens.at(-1) ?? 0) + " tokens")]),
    "-fill", "#19ad8c", ...draw(bars),
    "-fill", "#71717a", "-pointsize", "11", "-weight", "500",
    ...draw([mvgText(382, 310, "30 DAYS AGO"), mvgText(754, 310, "TODAY")]),
    "-pointsize", "10", ...draw([mvgText(28, 347, "Generated from OpenUsage local API · Estimates, not actual spend · Aggregate data only")]),
    "-strip", outputPath,
  ]
}

export const renderImage = async (activity, outputPath) => {
  const child = spawn("magick", buildImageArguments(activity, outputPath), { stdio: "inherit" })
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  if (exitCode !== 0) throw new OpenUsageDataError("ImageMagick exited with code " + exitCode)
}

const main = async () => {
  const response = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new OpenUsageDataError("OpenUsage API returned HTTP " + response.status)
  const activity = parseUsage(await response.json())
  await renderImage(activity, OUTPUT_PATH)
  console.log("Updated " + OUTPUT_PATH + " from " + API_URL)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
