/**
 * Deployment identities are bound to stable governance roles at the edge.
 * Canonical memory events persist roles, never account ids, usernames, or
 * provider identities.
 */

export type AuthorityRole = "owner" | "companion" | "system";
export type HumanAuthorityRole = Exclude<AuthorityRole, "system">;

export const GOVERNANCE_CAPABILITIES = [
  "propose",
  "confirm",
  "seal",
  "unseal",
  "set_retrieval",
  "approve_prior",
  "register_owner_policy",
  "activate_policy",
  "run_automation",
] as const;

export type GovernanceCapability = (typeof GOVERNANCE_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Readonly<Record<AuthorityRole, ReadonlySet<GovernanceCapability>>> = {
  owner: new Set(GOVERNANCE_CAPABILITIES.filter((capability) => capability !== "run_automation")),
  companion: new Set(["propose", "confirm", "seal", "unseal", "set_retrieval", "approve_prior"]),
  system: new Set(["propose", "activate_policy", "run_automation"]),
};

declare const principalIdBrand: unique symbol;
export type PrincipalId = string & { readonly [principalIdBrand]: true };

export function principalId(value: string): PrincipalId {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9._:-]{0,127}$/i.test(normalized)) {
    throw new TypeError("principal id must be a non-empty portable identifier");
  }
  return normalized as PrincipalId;
}

export interface PrincipalBinding {
  id: PrincipalId;
  roles: readonly AuthorityRole[];
  /** Public/operator label only. Never use a real name in distributable fixtures. */
  label?: string;
}

export interface PrincipalResolution {
  id: PrincipalId;
  roles: ReadonlySet<AuthorityRole>;
  label?: string;
}

export class PrincipalRegistry {
  readonly #bindings = new Map<PrincipalId, PrincipalResolution>();

  constructor(bindings: readonly PrincipalBinding[]) {
    for (const binding of bindings) {
      if (this.#bindings.has(binding.id)) {
        throw new TypeError(`duplicate principal id: ${binding.id}`);
      }
      const roles = new Set(binding.roles);
      if (roles.size === 0) {
        throw new TypeError(`principal has no roles: ${binding.id}`);
      }
      this.#bindings.set(binding.id, {
        id: binding.id,
        roles,
        ...(binding.label === undefined ? {} : { label: binding.label }),
      });
    }
  }

  resolve(id: PrincipalId): PrincipalResolution | undefined {
    return this.#bindings.get(id);
  }

  hasCapability(id: PrincipalId, capability: GovernanceCapability): boolean {
    const principal = this.resolve(id);
    return principal !== undefined && [...principal.roles].some(
      (role) => ROLE_CAPABILITIES[role].has(capability),
    );
  }

  requireCapability(id: PrincipalId, capability: GovernanceCapability): PrincipalResolution {
    const principal = this.resolve(id);
    if (principal === undefined || !this.hasCapability(id, capability)) {
      throw new Error(`principal is not authorized for ${capability}`);
    }
    return principal;
  }

  canonicalActor(id: PrincipalId, requestedRole?: AuthorityRole): AuthorityRole {
    const principal = this.resolve(id);
    if (principal === undefined) {
      throw new Error("unknown principal");
    }
    if (requestedRole !== undefined) {
      if (!principal.roles.has(requestedRole)) {
        throw new Error("principal does not hold the requested role");
      }
      return requestedRole;
    }
    for (const role of ["owner", "companion", "system"] as const) {
      if (principal.roles.has(role)) {
        return role;
      }
    }
    throw new Error("principal has no canonical role");
  }
}

/** Synthetic reference bindings for examples and tests only. */
export function syntheticPrincipalRegistry(): PrincipalRegistry {
  return new PrincipalRegistry([
    { id: principalId("owner"), roles: ["owner"], label: "Owner" },
    { id: principalId("companion"), roles: ["companion"], label: "Companion" },
    { id: principalId("system"), roles: ["system"], label: "System" },
  ]);
}
