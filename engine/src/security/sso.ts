// ============================================================================
// SSO / SAML 2.0 — per-tenant IdP configuration.
//
// SP-initiated flow:
//   GET  /sso/login?tenant=<id>   -> redirect to the IdP with an AuthnRequest
//   POST /sso/acs?tenant=<id>     -> validate the signed SAMLResponse
//                                    (@node-saml handles XML-DSig), map IdP
//                                    groups to a platform role, JIT-provision
//                                    or match the user by email, issue session
//   GET  /sso/metadata?tenant=<id>-> SP metadata XML for the IdP admin
//
// Group→role mapping is a pure function (first matching mapping wins; the
// most privileged role wins on multiple matches; falls back to default_role).
// ============================================================================

import { SAML } from '@node-saml/node-saml';
import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

export interface GroupRoleMapping { group: string; role: string }

const ROLE_RANK: Record<string, number> = {
  viewer: 0, collector: 1, biller: 2, client_admin: 3, tenant_admin: 4, super_admin: 5,
};
const ASSIGNABLE = new Set(Object.keys(ROLE_RANK));

/** pure: IdP group list -> platform role */
export function mapGroupsToRole(
  mappings: GroupRoleMapping[], groups: string[], defaultRole: string,
): string {
  const normalized = groups.map((g) => g.trim().toLowerCase());
  let best: string | null = null;
  for (const m of mappings) {
    if (!ASSIGNABLE.has(m.role)) continue;
    if (normalized.includes(m.group.trim().toLowerCase())) {
      if (best == null || ROLE_RANK[m.role] > ROLE_RANK[best]) best = m.role;
    }
  }
  return best ?? (ASSIGNABLE.has(defaultRole) ? defaultRole : 'viewer');
}

export interface SsoConfigRow {
  enabled: boolean;
  idp_entity_id: string | null;
  idp_sso_url: string | null;
  idp_certificate: string | null;
  group_attribute: string;
  group_role_mappings: GroupRoleMapping[];
  default_role: string;
}

export async function loadSsoConfig(db: Queryable, tenantId: UUID): Promise<SsoConfigRow | null> {
  const rows = await db.query(
    `SELECT enabled, idp_entity_id, idp_sso_url, idp_certificate,
            group_attribute, group_role_mappings, default_role
     FROM sso_config WHERE tenant_id = $1`, [tenantId]);
  return rows.rows[0] ?? null;
}

export function spEntityId(baseUrl: string, tenantId: UUID): string {
  return `${baseUrl}/sso/metadata?tenant=${tenantId}`;
}

function samlFor(baseUrl: string, tenantId: UUID, cfg: SsoConfigRow): SAML {
  if (!cfg.idp_sso_url || !cfg.idp_certificate) {
    throw Object.assign(new Error('SSO is not fully configured for this tenant'), { status: 409 });
  }
  return new SAML({
    callbackUrl: `${baseUrl}/sso/acs?tenant=${tenantId}`,
    entryPoint: cfg.idp_sso_url,
    issuer: spEntityId(baseUrl, tenantId),
    idpCert: cfg.idp_certificate,
    audience: spEntityId(baseUrl, tenantId),
    wantAssertionsSigned: true,
    acceptedClockSkewMs: 5000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  });
}

export async function buildLoginUrl(
  baseUrl: string, tenantId: UUID, cfg: SsoConfigRow,
): Promise<string> {
  const saml = samlFor(baseUrl, tenantId, cfg);
  return saml.getAuthorizeUrlAsync('', undefined, {});
}

export interface SsoAssertion {
  email: string;
  displayName: string | null;
  groups: string[];
}

export async function validateAcsResponse(
  baseUrl: string, tenantId: UUID, cfg: SsoConfigRow, body: Record<string, string>,
): Promise<SsoAssertion> {
  const saml = samlFor(baseUrl, tenantId, cfg);
  const { profile } = await saml.validatePostResponseAsync(body);
  if (!profile) throw Object.assign(new Error('SAML assertion rejected'), { status: 401 });

  const attrs = (profile.attributes ?? {}) as Record<string, unknown>;
  const rawGroups = attrs[cfg.group_attribute]
    ?? attrs[`http://schemas.xmlsoap.org/claims/${cfg.group_attribute}`];
  const groups = Array.isArray(rawGroups) ? rawGroups.map(String)
    : rawGroups != null ? [String(rawGroups)] : [];

  const email = String(profile.nameID ?? attrs.email ?? attrs.mail ?? '');
  if (!email.includes('@')) {
    throw Object.assign(new Error('assertion carries no usable email identifier'), { status: 400 });
  }
  const displayName = (attrs.displayName ?? attrs.cn ?? null) as string | null;
  return { email: email.toLowerCase(), displayName, groups };
}

export function spMetadataXml(baseUrl: string, tenantId: UUID): string {
  const entityId = spEntityId(baseUrl, tenantId);
  const acs = `${baseUrl}/sso/acs?tenant=${tenantId}`;
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
      protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="${acs}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}
