const campaignProperties = {
  utm_source: isCampaignLabel,
  utm_medium: isCampaignLabel,
  utm_campaign: isCampaignLabel,
  utm_id: (value: string) =>
    /^[0-9]{1,6}$/.test(value) || isCampaignLabel(value),
  utm_term: isCampaignLabel,
  utm_content: isCampaignLabel,
  utm_source_platform: isCampaignLabel,
  utm_creative_format: isCampaignLabel,
  utm_marketing_tactic: isCampaignLabel,
  gad_source: (value: string) => /^[1-9][0-9]{0,2}$/.test(value),
  gad_campaignid: (value: string) => /^[1-9][0-9]{0,18}$/.test(value),
  // Search Ads 360 documents these three nonempty click-source codes.
  gclsrc: (value: string) =>
    value === "aw.ds" || value === "ds" || value === "3p.ds",
  mc_cid: (value: string) => /^[0-9a-f]{10}$/i.test(value),
};

// Personal-data campaign keys from @posthog/browser-common 0.12.1, except
// allowlisted gclsrc codes, plus known click, recipient and Meta identifiers.
const identifierProperties = new Set([
  "_kx",
  "bfcid",
  "dclid",
  "epik",
  "fbc",
  "fbc_persistence",
  "fbclid",
  "fbp",
  "fbp_persistence",
  "gbraid",
  "gclid",
  "igshid",
  "irclid",
  "li_fat_id",
  "mc_eid",
  "msclkid",
  "oppref",
  "qclid",
  "rdt_cid",
  "sccid",
  "srsltid",
  "ttclid",
  "twclid",
  "wbraid",
  "yclid",
]);

function isCampaignLabel(value: string) {
  return (
    value.length <= 128 &&
    value === value.trim() &&
    /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[ _-]+[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u.test(
      value
    ) &&
    /\p{L}/u.test(value) &&
    !/(?:\p{Nd}[ _-]*){7}/u.test(value) &&
    !value.split(/[ _-]+/).some(isOpaqueIdentifier)
  );
}

function isOpaqueIdentifier(word: string) {
  return (
    /^[0-9a-f]{10,}$/i.test(word) ||
    /^[a-z0-9]{24,}$/i.test(word) ||
    (/^[a-z0-9]{16,}$/i.test(word) && /[0-9]/.test(word))
  );
}

function isCampaignKey(key: string): key is keyof typeof campaignProperties {
  return Object.hasOwn(campaignProperties, key);
}

function isIdentifierProperty(key: string) {
  return (
    identifierProperties.has(key) || /^_fb[cp](?:_persistence)?$/.test(key)
  );
}

function campaignKeyWithoutAliases(property: string) {
  return property
    .toLowerCase()
    .replace(/^\$?(?:(?:initial|session_entry|entry)_)?\$?/, "")
    .replace(/\[.*$/, "");
}

export function isPostHogCampaignProperty(property: string) {
  const key = campaignKeyWithoutAliases(property);
  return (
    key === "campaign_params" ||
    key.startsWith("utm_") ||
    isCampaignKey(key) ||
    isIdentifierProperty(key)
  );
}

function readCampaignProperties(url: URL) {
  const candidates = new Map<keyof typeof campaignProperties, string | null>();
  const identifierValues = new Set<string>();
  let tagged = false;

  for (const [name, value] of url.searchParams) {
    if (!isPostHogCampaignProperty(name)) continue;

    tagged = true;
    const key = campaignKeyWithoutAliases(name);
    if (isIdentifierProperty(key)) identifierValues.add(value.toLowerCase());
    if (isCampaignKey(key)) {
      candidates.set(key, name === key && !candidates.has(key) ? value : null);
    }
  }

  if (!tagged) return undefined;

  const properties: Record<string, string> = {};
  for (const [key, value] of candidates) {
    if (
      value !== null &&
      campaignProperties[key](value) &&
      !identifierValues.has(value.toLowerCase())
    ) {
      properties[key] = value;
    }
  }
  return properties;
}

export function readPageviewCampaignProperties(
  currentUrl: URL,
  getDocumentEntry?: () => string | undefined
) {
  const currentProperties = readCampaignProperties(currentUrl);
  if (currentProperties !== undefined) {
    return currentProperties;
  }

  const navigationUrl = getDocumentEntry?.();
  if (!navigationUrl) return undefined;

  try {
    const entryUrl = new URL(navigationUrl);
    if (
      entryUrl.origin === currentUrl.origin &&
      entryUrl.protocol === currentUrl.protocol &&
      !entryUrl.username &&
      !entryUrl.password
    ) {
      return readCampaignProperties(entryUrl);
    }
  } catch {
    return undefined;
  }
}
