/**
 * Anti-proof tests for the provider_egress health check (T05BCD discipline).
 *
 * The 08-03 incident showed that a health probe which never turns red is worse
 * than no probe at all: it makes operators believe they have coverage they don't.
 * These tests prove the new probes CAN fail — pointed at a blackhole, they MUST
 * report FAIL, not silently pass.
 *
 * Two levels:
 *   1. Pure evaluation: `evaluateHealth` with `providerEgressOk: false` MUST
 *      produce a FAIL check with fault kind `provider_outage`.
 *   2. Network probe: `probeProviderEgress` pointed at a non-listening address
 *      MUST return `ok: false`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHealth,
  type HealthObservation,
  HEALTH_CHECK_IDS,
} from "../core/services/reliability-core.js";
import {
  probeProviderEgress,
  probeProviderCredential,
} from "../adapters/runtime/health-runtime.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function healthyBaseline(): HealthObservation {
  return {
    pollerCount: 1,
    memoryWriterCount: 1,
    claimableItems: 0,
    liveOldestClaimableAgeSeconds: null,
    backfillRemaining: 0,
    backfillSettledInWindow: 0,
    backfillWindowSeconds: 10_800,
    receiptsTotal: 100,
    accountedStates: 100,
    newestProvenBackupAgeHours: 2,
    backupFreshnessBoundHours: 26,
    derivedIntegrity: { fts_items: "ok" },
    authoritativeIntegrity: { mnemosyne: "ok", decision_backlog: "ok" },
    freeBytes: 10_000_000_000,
    freeBytesFloor: 536_870_912,
    restartContinuityIntact: true,
    liveQueueSloSeconds: 3600,
    providerEgressOk: true,
    providerEgressDetail: "",
    providerCredentialOk: true,
    providerCredentialDetail: "",
  };
}

test("provider_egress is a registered health check id", () => {
  assert.ok(
    (HEALTH_CHECK_IDS as readonly string[]).includes("provider_egress"),
    "provider_egress must be in HEALTH_CHECK_IDS",
  );
});

test("provider_egress ok=true produces a passing check", () => {
  const obs = healthyBaseline();
  const receipt = evaluateHealth(obs);
  const check = receipt.checks.find((c) => c.id === "provider_egress");
  assert.ok(check, "provider_egress check must be present");
  assert.equal(check.ok, true);
  assert.equal(check.fault, null);
  assert.equal(receipt.verdict, "HEALTHY");
});

test("anti-proof: provider_egress ok=false produces FAIL with provider_outage fault", () => {
  const obs = { ...healthyBaseline(), providerEgressOk: false, providerEgressDetail: "blackhole test" };
  const receipt = evaluateHealth(obs);
  const check = receipt.checks.find((c) => c.id === "provider_egress");
  assert.ok(check, "provider_egress check must be present");
  assert.equal(check.ok, false, "provider_egress must FAIL when ok=false");
  assert.ok(check.fault, "a failing check must carry a fault");
  assert.equal(check.fault!.kind, "provider_outage");
  assert.equal(check.fault!.subject, "provider_egress");
  assert.notEqual(receipt.verdict, "HEALTHY", "verdict must not be HEALTHY when egress is down");
});

test("anti-proof: provider_egress ok=null (probe skipped) is a pass, not a silent failure", () => {
  const obs = { ...healthyBaseline(), providerEgressOk: null, providerEgressDetail: "no proxy" };
  const receipt = evaluateHealth(obs);
  const check = receipt.checks.find((c) => c.id === "provider_egress");
  assert.ok(check, "provider_egress check must be present");
  assert.equal(check.ok, true, "a skipped probe (null) should not fail the check");
});

test("anti-proof: probeProviderEgress returns false for a blackhole proxy address", async () => {
  const result = await probeProviderEgress("http://192.0.2.1:1");
  assert.equal(result.ok, false, "a probe to a blackhole address (RFC 5737 TEST-NET) must return false");
  assert.ok(result.detail.length > 0, "detail must explain why it failed");
});

test("anti-proof: probeProviderEgress returns null for no proxy", async () => {
  const result = await probeProviderEgress(null);
  assert.equal(result.ok, null, "no proxy configured means the probe is skipped, not a pass");
});

test("anti-proof: probeProviderEgress returns false for an invalid proxy URL", async () => {
  const result = await probeProviderEgress("not-a-url");
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("invalid"), "detail should mention the URL is invalid");
});

// ---------------------------------------------------------------------------
// provider_credential — CLI binary + credentials file
// ---------------------------------------------------------------------------

test("provider_credential is a registered health check id", () => {
  assert.ok(
    (HEALTH_CHECK_IDS as readonly string[]).includes("provider_credential"),
  );
});

test("provider_credential ok=true produces a passing check", () => {
  const obs = healthyBaseline();
  const receipt = evaluateHealth(obs);
  const check = receipt.checks.find((c) => c.id === "provider_credential");
  assert.ok(check, "provider_credential check must be present");
  assert.equal(check.ok, true);
  assert.equal(check.fault, null);
});

test("anti-proof: provider_credential ok=false produces FAIL with provider_outage fault", () => {
  const obs = {
    ...healthyBaseline(),
    providerCredentialOk: false,
    providerCredentialDetail: "credentials file corrupt",
  };
  const receipt = evaluateHealth(obs);
  const check = receipt.checks.find((c) => c.id === "provider_credential");
  assert.ok(check);
  assert.equal(check.ok, false, "must FAIL when credentials are bad");
  assert.ok(check.fault);
  assert.equal(check.fault!.kind, "provider_outage");
  assert.equal(check.fault!.subject, "provider_credential");
  assert.notEqual(receipt.verdict, "HEALTHY");
});

test("anti-proof: credential and egress can fail independently", () => {
  const egressDown = {
    ...healthyBaseline(),
    providerEgressOk: false, providerEgressDetail: "timeout",
    providerCredentialOk: true, providerCredentialDetail: "",
  };
  const credDown = {
    ...healthyBaseline(),
    providerEgressOk: true, providerEgressDetail: "",
    providerCredentialOk: false, providerCredentialDetail: "corrupt",
  };
  const rEgress = evaluateHealth(egressDown);
  const rCred = evaluateHealth(credDown);

  assert.equal(rEgress.checks.find((c) => c.id === "provider_egress")!.ok, false);
  assert.equal(rEgress.checks.find((c) => c.id === "provider_credential")!.ok, true);
  assert.equal(rCred.checks.find((c) => c.id === "provider_egress")!.ok, true);
  assert.equal(rCred.checks.find((c) => c.id === "provider_credential")!.ok, false);
});

test("anti-proof: probeProviderCredential returns null when no binary configured", async () => {
  const result = await probeProviderCredential(null, null);
  assert.equal(result.ok, null);
});

test("anti-proof: probeProviderCredential returns false for a non-existent binary", async () => {
  const result = await probeProviderCredential("/nonexistent/claude-bin", null);
  assert.equal(result.ok, false, "a non-existent binary must return false");
  assert.ok(result.detail.includes("not functional"), "detail must explain the binary failed");
});

test("anti-proof: probeProviderCredential returns false for missing credentials file", async () => {
  const d = mkdtempSync(join(tmpdir(), "t05c-cred-"));
  try {
    const result = await probeProviderCredential(
      "/bin/true",
      join(d, "nonexistent-credentials.json"),
    );
    assert.equal(result.ok, false, "missing credentials file must return false");
    assert.ok(result.detail.includes("missing"), "detail must mention file is missing");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("anti-proof: probeProviderCredential returns false for corrupt credentials file", async () => {
  const d = mkdtempSync(join(tmpdir(), "t05c-cred-"));
  try {
    const credPath = join(d, "credentials.json");
    writeFileSync(credPath, "NOT VALID JSON{{{");
    const result = await probeProviderCredential("/bin/true", credPath);
    assert.equal(result.ok, false, "corrupt credentials file must return false");
    assert.ok(result.detail.includes("corrupt"), "detail must mention corruption");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("anti-proof: probeProviderCredential returns false for empty credentials object", async () => {
  const d = mkdtempSync(join(tmpdir(), "t05c-cred-"));
  try {
    const credPath = join(d, "credentials.json");
    writeFileSync(credPath, "{}");
    const result = await probeProviderCredential("/bin/true", credPath);
    assert.equal(result.ok, false, "empty credentials object must return false");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("probeProviderCredential passes with valid credentials file", async () => {
  const d = mkdtempSync(join(tmpdir(), "t05c-cred-"));
  try {
    const credPath = join(d, "credentials.json");
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "test" } }));
    const result = await probeProviderCredential("/bin/true", credPath);
    assert.equal(result.ok, true, "valid credentials file must pass");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
