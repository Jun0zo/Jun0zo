#!/usr/bin/env node

import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { buildImageArguments } from "./openusage-card-render.mjs"

export { buildImageArguments } from "./openusage-card-render.mjs"

const API_URL = process.env.OPENUSAGE_API_URL ?? "http://127.0.0.1:6736/v1/usage"
const OUTPUT_PATH = process.env.OPENUSAGE_CARD_OUTPUT ?? "cards/openusage-last30.png"
const MOBILE_OUTPUT_PATH = process.env.OPENUSAGE_MOBILE_CARD_OUTPUT ?? "cards/openusage-last30-mobile.png"

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

const MONTH_NUMBERS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const parsePointDate = (label, fetchedAt) => {
  const normalizedLabel = label.trim()
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizedLabel)
  const koreanMatch = /^(\d{1,2})월\s*(\d{1,2})일$/.exec(normalizedLabel)
  const englishMatch = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(normalizedLabel)
  let month
  let day
  let explicitYear
  if (isoMatch !== null) {
    explicitYear = Number(isoMatch[1])
    month = Number(isoMatch[2])
    day = Number(isoMatch[3])
  } else if (koreanMatch !== null) {
    month = Number(koreanMatch[1])
    day = Number(koreanMatch[2])
  } else if (englishMatch !== null) {
    month = MONTH_NUMBERS[englishMatch[1].slice(0, 3).toLowerCase()]
    day = Number(englishMatch[2])
    explicitYear = englishMatch[3] === undefined ? undefined : Number(englishMatch[3])
  } else {
    throw new OpenUsageDataError("Unsupported trend point label: " + label)
  }
  const fetchedTime = Date.parse(fetchedAt)
  if (month === undefined || day === undefined || Number.isNaN(fetchedTime)) {
    throw new OpenUsageDataError("Invalid trend point date: " + label)
  }
  const fetchedDate = new Date(fetchedTime)
  const candidateYears = explicitYear === undefined
    ? [fetchedDate.getUTCFullYear() - 1, fetchedDate.getUTCFullYear(), fetchedDate.getUTCFullYear() + 1]
    : [explicitYear]
  const candidates = candidateYears
    .map((year) => ({ year, date: new Date(Date.UTC(year, month - 1, day)) }))
    .filter(({ year, date }) => date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 && date.getUTCDate() === day)
    .map(({ date }) => date)
  if (candidates.length === 0) throw new OpenUsageDataError("Invalid trend point date: " + label)
  const notFuture = candidates.filter((date) => date.getTime() <= fetchedTime + 86_400_000)
  const reference = notFuture.length === 0 ? candidates : notFuture
  reference.sort((left, right) =>
    Math.abs(left.getTime() - fetchedTime) - Math.abs(right.getTime() - fetchedTime))
  return reference[0].toISOString().slice(0, 10)
}

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
  const dailyPoints = trendLine.points.map((point) => {
    if (!isRecord(point) || typeof point.label !== "string" ||
      typeof point.value !== "number" || !Number.isFinite(point.value)) {
      throw new OpenUsageDataError("Provider " + snapshot.providerId + " has an invalid trend point")
    }
    return { date: parsePointDate(point.label, snapshot.fetchedAt), value: point.value }
  })
  return {
    id: snapshot.providerId,
    name: snapshot.displayName,
    costUsd: spend.costUsd,
    tokens: spend.formattedTokens,
    dailyPoints,
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

  const totalsByDate = new Map()
  for (const provider of providers) {
    for (const point of provider.dailyPoints) {
      totalsByDate.set(point.date, (totalsByDate.get(point.date) ?? 0) + point.value)
    }
  }
  const dailyTokens = [...totalsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-30)
    .map(([, value]) => value)
  return {
    providers,
    totalCostUsd: providers.reduce((sum, provider) => sum + provider.costUsd, 0),
    totalTokens: providers.reduce((sum, provider) => sum + provider.tokens, 0),
    dailyTokens,
    activeDays: dailyTokens.filter((value) => value > 0).length,
    refreshedAt: providers.map(({ fetchedAt }) => fetchedAt).sort().at(-1) ?? "",
  }
}

export const renderImage = async (activity, outputPath, variant = "desktop") => {
  const child = spawn("magick", buildImageArguments(activity, outputPath, variant), { stdio: "inherit" })
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
  await Promise.all([
    renderImage(activity, OUTPUT_PATH),
    renderImage(activity, MOBILE_OUTPUT_PATH, "mobile"),
  ])
  console.log("Updated " + OUTPUT_PATH + " and " + MOBILE_OUTPUT_PATH + " from " + API_URL)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
