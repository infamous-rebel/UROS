import { requireCredential, storeCredential } from "../credential_store";
import { logAudit } from "../../../utils/audit_helper";
import { logger } from "../../../utils/logger";

export interface LinkedInProfile {
  profile_id: string;
  full_name: string;
  headline?: string;
  email?: string;
  experience: Array<{ organization: string; designation: string; start_date?: string; end_date?: string }>;
  education: Array<{ institution: string; degree?: string; field_of_study?: string }>;
}

/**
 * Returns the LinkedIn OAuth 2.0 authorization URL for an org admin to
 * grant UROS access. client_id comes from the org's BYOK-stored OAuth
 * app credential (label "oauth_client_id").
 */
export async function getAuthorizationUrl(orgId: string, redirectUri: string, state: string): Promise<string> {
  const { apiKey: clientId } = await requireCredential(orgId, "linkedin", "oauth_client_id");
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "r_liteprofile r_emailaddress");
  return url.toString();
}

/**
 * Exchanges an OAuth authorization code for an access token and stores it
 * (encrypted) under label "access_token" for subsequent profile fetches.
 */
export async function exchangeCodeForToken(
  orgId: string,
  code: string,
  redirectUri: string,
  actorUserId: string
): Promise<void> {
  const { apiKey: clientId } = await requireCredential(orgId, "linkedin", "oauth_client_id");
  const { apiKey: clientSecret } = await requireCredential(orgId, "linkedin", "oauth_client_secret");

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`LinkedIn token exchange failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { access_token: string };

  await storeCredential(orgId, "linkedin", body.access_token, actorUserId, { label: "access_token" });

  await logAudit({
    entity_type: "INTEGRATION",
    entity_id: orgId,
    agent_or_user: actorUserId,
    action: "LINKEDIN_OAUTH_COMPLETED",
    output_value: { connector: "linkedin" },
  });
}

/** Fetches a candidate profile for corporate-role import (file 06 §3). */
export async function fetchProfile(orgId: string, profileId: string): Promise<LinkedInProfile> {
  const { apiKey } = await requireCredential(orgId, "linkedin", "access_token");

  try {
    const res = await fetch(`https://api.linkedin.com/v2/people/${profileId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`LinkedIn profile fetch failed: ${res.status} ${res.statusText}`);
    const profile = (await res.json()) as LinkedInProfile;

    await logAudit({
      entity_type: "INTEGRATION",
      entity_id: profileId,
      agent_or_user: "LinkedInConnector",
      action: "PROFILE_FETCHED",
      output_value: { connector: "linkedin", profile_id: profileId },
    });

    return profile;
  } catch (err) {
    logger.error("LINKEDIN_PROFILE_FETCH_FAILED", {
      profileId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
