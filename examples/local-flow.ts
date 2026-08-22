import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import { buildMemoryReadPacket } from "../core/services/anamnesis.js";
import { MnemosyneGovernanceService } from "../core/services/mnemosyne-governance.js";

const root = mkdtempSync(join(tmpdir(), "mnemosyne-public-example-"));
const databasePath = join(root, "mnemosyne.db");
const handle = openMnemosyne(databasePath);

try {
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (label) => ({ path: join(root, `synthetic-backup-${label}`) }),
    audit: () => undefined,
  });
  const policyId = "synthetic-owner-policy-v1";
  const registered = await service.ensureOwnerPolicy({
    policyId,
    authority: "owner_global_policy",
    effectiveFrom: new Date(0).toISOString(),
    manualPerCardApprovalRequired: false,
    ownerCanViewEditRevoke: true,
    authorityRef: `sha256:${"a".repeat(64)}`,
  });
  if (registered.status === "refused") throw new Error("synthetic policy registration failed");

  const written = await service.proposeUnderPolicy({
    body: "Synthetic fixture: the lunar greenhouse audit is scheduled every Monday.",
    title: "Synthetic lunar greenhouse schedule",
    tags: ["synthetic", "greenhouse"],
    scope: "project",
    sensitivity: "normal",
    importance: 2,
    evidence: {
      kind: "transcript",
      conversationId: "11111111-0000-4000-8000-000000000001",
      turnId: "22222222-0000-4000-8000-000000000001",
      messageId: "33333333-0000-4000-8000-000000000001",
    },
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion", proposal_origin: "companion_self" },
    activation: { policyId, sourceBasis: "explicit", generator: "synthetic-example" },
  });
  if (written.status !== "ok") throw new Error(`synthetic write failed: ${written.status}`);

  const packet = buildMemoryReadPacket({
    source: handle.store,
    query: "lunar greenhouse",
    scene: { mode: "ordinary", intimacyActive: false },
    nowIso: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    written: written.status,
    approval: service.getCard(written.memoryId)?.approval_state,
    retrieved: packet.memories.length,
    auditSelected: packet.audit.selected.length,
  }));
} finally {
  handle.log.close();
  rmSync(root, { recursive: true, force: true });
}
