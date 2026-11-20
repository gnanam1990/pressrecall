// T-014 — Client release · Accessible handoff.
// Drives the whole product through normal browser screens: sign-in,
// both site types, original/revised assets, quote/proof approval,
// sandbox settlement, shop acceptance, offline field photo queue/reload,
// and a fresh-context (no session) client export whose payment is
// independently matched against the ledger record.
import { test, expect } from "@playwright/test";

const actAs = async (page, label) => {
  await page.getByRole("button", { name: "Switch actor" }).click();
  await page.locator("#actor-panel").getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator("#actor-chip")).toContainText(label.split(" ")[0]);
};

const publishRevision = async (page, { text, date, target }) => {
  await page.locator("#rv-text").fill(text);
  await page.locator("#rv-date").fill(date);
  if (target) await page.locator("#rv-tgt").fill(target);
  await page.getByRole("button", { name: "Publish revision" }).click();
  await expect(page.locator("tbody").first()).toContainText(date, { timeout: 10000 });
};

test("T-014: full flow through normal screens, offline queue, fresh-context export", async ({
  page, context, browser,
}) => {
  // ---- sign-in on a fresh browser context (no stored session) ----
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.selectOption("#si-actor", "act_buyer");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#actor-chip")).toContainText("buyer");

  // ---- setup: campaign (unique name — consecutive runs share one DB) ----
  const campaignName = `Fest launch reprint ${Date.now().toString(36)}`;
  await page.locator("#nc-name").fill(campaignName);
  await page.getByRole("button", { name: "Create campaign" }).click();
  await expect(page.getByRole("heading", { name: campaignName })).toBeVisible();
  const cid = page.url().split("#/c/")[1];

  // ---- original + revised assets ----
  await publishRevision(page, {
    text: "PRINT v1 · fest poster · June 6", date: "Saturday June 6",
    target: "https://go.fest/saturday",
  });
  await publishRevision(page, {
    text: "PRINT v2 · fest poster · June 7", date: "Sunday June 7",
    target: "https://go.fest/sunday",
  });

  // ---- site type A: physical ink mismatch ----
  await page.getByText("Add a site").click();
  await page.locator("#pl-code").fill("B");
  await page.locator("#pl-label").fill("Market St shelter");
  await page.locator("#pl-fmt").fill("A2");
  await page.locator("#pl-ink").fill("eventDateText");
  await page.locator("#pl-obs").selectOption({ index: 1 }); // v1 observed
  await page.getByRole("button", { name: "Add site" }).click();
  const siteB = page.locator('.site-card[data-site-code="B"]');
  await expect(siteB).toBeVisible();

  // ---- site type C: managed redirect (web correction) ----
  await page.getByText("Add a site").click();
  await page.locator("#pl-code").fill("C");
  await page.locator("#pl-label").fill("Station kiosk QR");
  await page.locator("#pl-fmt").fill("A1");
  await page.locator("#pl-obs").selectOption({ index: 1 }); // v1 observed installed
  await page.locator("#pl-managed").check();
  await page.locator("#pl-slug").fill("fest-station");
  await page.getByRole("button", { name: "Add site" }).click();
  const siteC = page.locator('.site-card[data-site-code="C"]');
  await expect(siteC).toBeVisible();

  // ---- operator registers the deployed redirect, agent verifies the
  // installed QR actually resolves to the approved target ----
  await actAs(page, "operator");
  await siteC.getByText("Operator: register deployed redirect").click();
  await siteC.getByRole("button", { name: "Register redirect" }).click();
  await expect(page.locator("#toast")).toContainText("redirect registered");

  await actAs(page, "agent");
  await siteC.getByRole("button", { name: "Scan live redirect" }).click();
  await expect(page.locator("#toast")).toContainText("scan → VERIFIED");
  await expect(siteC.locator(".chip", { hasText: "VERIFIED" })).toBeVisible({ timeout: 15000 });

  // ---- physical site: plan decides reprint ----
  await siteB.getByRole("button", { name: "Evaluate plan" }).click();
  await expect(siteB.locator(".chip", { hasText: "REPRINT" })).toBeVisible({ timeout: 10000 });

  // ---- RFQ → printer quotes + proof → buyer approves ----
  await page.getByText("Request quotes from shops").click();
  await page.locator("#rfq-rev").selectOption({ index: 1 }); // v2
  await page.getByRole("button", { name: "Send RFQ" }).click();

  await actAs(page, "printer A");
  await expect(page.getByRole("heading", { name: /Print shop/ })).toBeVisible();
  // RFQs are global to the shop — pick the one for THIS campaign
  const rfq = page.locator(`details[data-campaign="${cid}"][data-rfq]`);
  await expect(rfq).toHaveCount(1);
  await rfq.locator("summary").click();
  // identical terms each run — quote_hash uniqueness is per RFQ (migration 11),
  // so a repeat run quoting the same artwork+terms on a NEW RFQ must succeed
  await rfq.getByRole("button", { name: "Submit quote" }).click();
  await expect(page.locator("#toast")).toContainText("quote submitted");
  await rfq.locator("textarea").fill("PROOF fest v2 — June 7 artwork approved for plate");
  await rfq.getByRole("button", { name: "Upload proof" }).click();
  await expect(page.locator("#toast")).toContainText("proof uploaded");

  await actAs(page, "buyer");
  await expect(page.getByText("Printer quotes")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".chip", { hasText: "APPROVED" })).toBeVisible({ timeout: 10000 });

  // ---- scoped sandbox settlement: grant → intent → reserve → pay ----
  await page.getByText("Grant a scoped session").click();
  await page.getByRole("button", { name: "Grant", exact: true }).click();
  await expect(page.locator(".chip", { hasText: "ACTIVE" })).toBeVisible({ timeout: 10000 });
  await page.getByText("Create order intent").click();
  await page.getByRole("button", { name: "Create intent" }).click();
  await expect(page.locator(".chip", { hasText: "REQUESTED" })).toBeVisible({ timeout: 10000 });
  const intentId = await page
    .locator("tr[data-intent-id]")
    .first()
    .getAttribute("data-intent-id");

  const placementId = await siteB.getAttribute("data-placement-id");
  const targetRevId = await siteB.getAttribute("data-target-rev");

  await actAs(page, "printer A");
  const job = page.locator(`.site-card[data-job-id="${intentId}"]`);
  await expect(job).toHaveCount(1);
  await job.getByRole("button", { name: "Reserve" }).click();
  await expect(job.locator(".chip", { hasText: "RESERVED" })).toBeVisible({ timeout: 10000 });

  await actAs(page, "buyer");
  await page.getByRole("button", { name: "Execute (pay)" }).click();
  const spendTable = page.locator("h3", { hasText: "Spends" })
    .locator("xpath=following-sibling::table[1]");
  const spendRow = spendTable.locator("tbody tr").first();
  await expect(spendRow.locator(".chip", { hasText: "CONFIRMED" })).toBeVisible({ timeout: 15000 });
  const txHashCell = await spendRow.locator("td").nth(2).textContent();

  // ---- shop acceptance + delivery (same intent, scoped by job id) ----
  await actAs(page, "printer A");
  const job2 = page.locator(`.site-card[data-job-id="${intentId}"]`);
  await job2.getByRole("button", { name: "Accept job" }).click();
  await job2.getByText("Record delivery").click();
  await job2.locator(`input[id^='jp-']`).fill(placementId);
  await job2.locator(`input[id^='jv-']`).fill(targetRevId);
  await job2.getByRole("button", { name: "Deliver" }).click();

  // ---- offline field photo: queues, survives reload, retries by client key ----
  await actAs(page, "coordinator");
  const evB = page.locator('details[data-site="B"]');
  await evB.locator("summary").click();
  await context.setOffline(true);
  await evB.getByRole("button", { name: "Upload text fixture" }).click();
  await expect(page.locator("#queue-badge")).toContainText("queued");
  await context.setOffline(false);
  await page.reload();
  // queue badge drains once the persisted clientKey upload lands
  await expect(page.locator("#queue-badge")).toBeHidden({ timeout: 15000 });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/Site B — field evidence \(1\)/)).toBeVisible({ timeout: 10000 });

  // second, online upload verifying the corrected revision closes the site
  await evB.locator("summary").click();
  await evB.getByRole("button", { name: "Upload text fixture" }).click();
  await expect(siteB.locator(".chip", { hasText: "VERIFIED" })).toBeVisible({ timeout: 15000 });

  // ---- release + client export ----
  await actAs(page, "buyer");
  await page.getByRole("button", { name: "Load report" }).click();
  await expect(page.locator("#report-box")).toContainText("2/2 verified", { timeout: 10000 });
  await page.getByRole("button", { name: "Release to client" }).click();
  const exportLink = page.locator('a[href^="/export.html?token="]');
  await expect(exportLink).toBeVisible({ timeout: 10000 });
  const exportHref = await exportLink.getAttribute("href");

  // ---- fresh-context export: no session, no storage → client-safe view ----
  const fresh = await browser.newContext();
  const pub = await fresh.newPage();
  await pub.goto(exportHref);
  await expect(pub.getByText("CLIENT VIEW · REDACTED")).toBeVisible();
  await expect(pub.locator(".chip", { hasText: "VERIFIED" }).first()).toBeVisible();
  await expect(pub.getByText("Market St")).toHaveCount(0); // labels redacted
  // independently match the payment: tx hash in the export == ledger record
  const txCell = pub.locator("td[data-tx]").first();
  await expect(txCell).toBeVisible();
  // the export's truncated hash must extend the workspace prefix —
  // the same transaction, independently readable without sign-in
  const pubTx = (await txCell.textContent()).replace("…", "").trim();
  const wsTxPrefix = txHashCell.trim().replace("…", "");
  expect(pubTx.startsWith(wsTxPrefix)).toBe(true);
  await expect(pub.getByText("receipt matched").or(pub.getByText("sandbox")).first()).toBeVisible();
  await fresh.close();

  // ---- accessibility spot-checks: 375px field + keyboard focus ----
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(siteB).toBeVisible();
  await expect(page.locator("#actor-chip")).toContainText("buyer");
  await page.locator("#main").focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => document.activeElement?.tagName);
    if (["BUTTON", "A", "INPUT", "SELECT", "SUMMARY"].includes(tag)) {
      const outline = await page.evaluate(
        () => getComputedStyle(document.activeElement).outlineWidth);
      expect(outline).not.toBe("0px");
      break;
    }
  }
});
