const PROVIDER_COLORS = {
  codex: "#19ad8c",
  claude: "#e8785b",
  opencode: "#5ea8ff",
}
const FALLBACK_COLOR = "#c084fc"

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

const buildDonut = (activity, centerX, centerY, radius, strokeWidth) => {
  const spending = activity.providers.filter(({ costUsd }) => costUsd > 0)
  const total = spending.reduce((sum, provider) => sum + provider.costUsd, 0)
  const commands = [
    "-fill", "none", "-stroke", "#303034", "-strokewidth", String(strokeWidth),
    ...draw(["circle " + centerX + "," + centerY + " " + centerX + "," + (centerY - radius)]),
  ]
  if (total === 0) return commands

  let startAngle = 0
  for (const [index, provider] of spending.entries()) {
    const endAngle = index === spending.length - 1
      ? 359.9
      : startAngle + (provider.costUsd / total) * 359.9
    commands.push("-stroke", providerColor(provider.id), ...draw([
      arcPath(centerX, centerY, radius, startAngle, endAngle),
    ]))
    startAngle = endAngle
  }
  return commands
}

const codexShare = (activity) => {
  const spending = activity.providers.filter(({ costUsd }) => costUsd > 0)
  const total = spending.reduce((sum, provider) => sum + provider.costUsd, 0)
  const codex = spending.find(({ id }) => id === "codex")
  return codex === undefined || total === 0 ? 0 : codex.costUsd / total
}

const providerRows = (activity, startY, rowStep, bulletX, labelX, detailX, labelSize, detailSize) =>
  activity.providers.slice(0, 4).flatMap((provider, index) => {
    const y = startY + index * rowStep
    const detail = provider.costUsd > 0
      ? formatMoney(provider.costUsd)
      : formatCompact(provider.tokens) + " tokens"
    return [
      "-fill", providerColor(provider.id), ...draw(["circle " + bulletX + "," + (y - 5) +
        " " + (bulletX + 5) + "," + (y - 5)]),
      "-fill", "#e4e4e7", "-pointsize", String(labelSize), "-weight", "600",
      ...draw([mvgText(labelX, y, provider.name)]),
      "-fill", "#a1a1aa", "-pointsize", String(detailSize), "-weight", "600",
      ...draw([mvgText(detailX, y, detail)]),
    ]
  })

const buildBars = (dailyTokens, startX, bottomY, chartWidth, maxHeight) => {
  const maximum = Math.max(...dailyTokens, 1)
  const columnWidth = chartWidth / Math.max(dailyTokens.length, 1)
  return dailyTokens.map((value, index) => {
    const height = Math.max(2, Math.round((value / maximum) * maxHeight))
    const x = startX + index * columnWidth
    return "roundrectangle " + x + "," + (bottomY - height) + " " +
      (x + Math.max(3, columnWidth - 3)) + "," + bottomY + " 2,2"
  })
}

const buildDesktopImageArguments = (activity, outputPath) => {
  const share = codexShare(activity)
  return [
    "-size", "846x360", "xc:#18181a", "-font", "Arial",
    "-stroke", "#343438", "-strokewidth", "1", "-fill", "none",
    ...draw(["roundrectangle 0.5,0.5 845.5,359.5 14,14", "line 28,66 818,66",
      "line 342,88 342,314", "line 28,326 818,326"]),
    "-stroke", "none", "-fill", "#f4f4f5", "-pointsize", "18", "-weight", "700",
    ...draw([mvgText(48, 35, "OpenUsage Snapshot")]),
    "-fill", "#71717a", "-pointsize", "11", "-weight", "500",
    ...draw([mvgText(705, 27, "@JUN0ZO"), mvgText(642, 46,
      "LAST 30 DAYS · " + activity.refreshedAt.slice(0, 10))]),
    "-fill", "#8b8b94", "-pointsize", "10", "-weight", "700",
    ...draw([mvgText(28, 92, "API-EQUIVALENT ESTIMATE"), mvgText(382, 92, "DAILY TOKEN ACTIVITY")]),
    "-fill", "#f4f4f5", "-pointsize", "42", "-weight", "700",
    ...draw([mvgText(28, 139, formatMoney(activity.totalCostUsd))]),
    "-fill", "#a1a1aa", "-pointsize", "13", "-weight", "500",
    ...draw([mvgText(28, 164, formatCompact(activity.totalTokens) + " tokens · " +
      activity.activeDays + "/" + activity.dailyTokens.length + " active days")]),
    ...buildDonut(activity, 100, 237, 50, 18),
    "-stroke", "none", "-fill", "#f4f4f5", "-pointsize", "16", "-weight", "700",
    ...draw([mvgText(74, 237, (share * 100).toFixed(1) + "%")]),
    "-fill", "#71717a", "-pointsize", "9", "-weight", "500", ...draw([mvgText(77, 253, "CODEX")]),
    ...providerRows(activity, 205, 30, 190, 205, 274, 13, 12),
    "-fill", "#d4d4d8", "-pointsize", "12", "-weight", "600", ...draw([mvgText(382, 128, "Latest")]),
    "-fill", "#a1a1aa", ...draw([mvgText(704, 128,
      formatCompact(activity.dailyTokens.at(-1) ?? 0) + " tokens")]),
    "-fill", "#19ad8c", ...draw(buildBars(activity.dailyTokens, 382, 286, 410, 90)),
    "-fill", "#71717a", "-pointsize", "11", "-weight", "500",
    ...draw([mvgText(382, 310, "30 DAYS AGO"), mvgText(754, 310, "TODAY")]),
    "-pointsize", "10", ...draw([mvgText(28, 347,
      "Generated from OpenUsage local API · Estimates, not actual spend · Aggregate data only")]),
    "-strip", outputPath,
  ]
}

const buildMobileImageArguments = (activity, outputPath) => {
  const share = codexShare(activity)
  return [
    "-size", "640x760", "xc:#18181a", "-font", "Arial",
    "-stroke", "#343438", "-strokewidth", "1", "-fill", "none",
    ...draw(["roundrectangle 0.5,0.5 639.5,759.5 18,18", "line 30,90 610,90",
      "line 30,430 610,430", "line 30,704 610,704"]),
    "-stroke", "none", "-fill", "#f4f4f5", "-pointsize", "28", "-weight", "700",
    ...draw([mvgText(40, 52, "OpenUsage Snapshot")]),
    "-fill", "#a1a1aa", "-pointsize", "15", "-weight", "500",
    ...draw([mvgText(520, 39, "@JUN0ZO"), mvgText(400, 67,
      "LAST 30 DAYS · " + activity.refreshedAt.slice(0, 10))]),
    "-fill", "#b4b4bc", "-pointsize", "15", "-weight", "700",
    ...draw([mvgText(40, 121, "API-EQUIVALENT ESTIMATE")]),
    "-fill", "#f4f4f5", "-pointsize", "58", "-weight", "700",
    ...draw([mvgText(40, 181, formatMoney(activity.totalCostUsd))]),
    "-fill", "#c1c1c7", "-pointsize", "18", "-weight", "500",
    ...draw([mvgText(40, 212, formatCompact(activity.totalTokens) + " tokens · " +
      activity.activeDays + "/" + activity.dailyTokens.length + " active days")]),
    ...buildDonut(activity, 145, 315, 88, 24),
    "-stroke", "none", "-fill", "#f4f4f5", "-pointsize", "24", "-weight", "700",
    ...draw([mvgText(111, 319, (share * 100).toFixed(1) + "%")]),
    "-fill", "#8b8b94", "-pointsize", "12", "-weight", "500", ...draw([mvgText(121, 342, "CODEX")]),
    ...providerRows(activity, 258, 48, 318, 338, 468, 19, 17),
    "-fill", "#b4b4bc", "-pointsize", "18", "-weight", "700",
    ...draw([mvgText(40, 468, "DAILY TOKEN ACTIVITY")]),
    "-fill", "#c1c1c7", "-pointsize", "17", "-weight", "600",
    ...draw([mvgText(470, 468, formatCompact(activity.dailyTokens.at(-1) ?? 0) + " tokens")]),
    "-fill", "#19ad8c", ...draw(buildBars(activity.dailyTokens, 60, 635, 520, 135)),
    "-fill", "#8b8b94", "-pointsize", "15", "-weight", "500",
    ...draw([mvgText(60, 663, "30 DAYS AGO"), mvgText(535, 663, "TODAY")]),
    "-fill", "#a1a1aa", "-pointsize", "14", "-weight", "500",
    ...draw([mvgText(40, 735, "API-equivalent estimate · Aggregate data only")]),
    "-strip", outputPath,
  ]
}

export const buildImageArguments = (activity, outputPath, variant = "desktop") =>
  variant === "mobile"
    ? buildMobileImageArguments(activity, outputPath)
    : buildDesktopImageArguments(activity, outputPath)
