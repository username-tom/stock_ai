export function getReportFilename(reportPath) {
  if (!reportPath) return ''
  const parts = String(reportPath).split(/[\\/]/)
  return parts[parts.length - 1] || ''
}
