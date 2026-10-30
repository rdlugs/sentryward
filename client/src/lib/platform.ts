// navigator.platform is deprecated and frozen or empty in some browsers, so
// User-Agent Client Hints come first. userAgentData is not in lib.dom yet.
export function isMac() {
  if (typeof navigator === "undefined") return false
  const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = hints?.platform || navigator.platform || navigator.userAgent
  return /mac|iphone|ipad/i.test(platform)
}
