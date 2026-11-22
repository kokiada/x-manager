import { createAndRunJob } from './bulkPostService';
import { seededRandom } from './analytics';
import { dueSlots, nextSlot, type AutoPostRuleShape, type AutoPostSlot } from './autoPost';
import {
  addAutoPostRun,
  getMeta,
  getTemplate,
  latestBanCheckFor,
  listAccounts,
  listAutoPostRules,
  localDateString,
  setMeta,
} from '../db/repository';
import type { AutoPostRule, ComposePayload } from '../db/types';

/**
 * Auto-post engine (research §6-6).
 *
 * Runs while the app is open: every tick it checks each enabled
 * rule's due slots (today + yesterday, to catch overnight windows),
 * records >15-min-late slots as skipped, and fires due slots through
 * the bulk-post job runner with the spec spacing (60 s + 0–30 s
 * random between accounts). With skipIfSearchBan, accounts judged
 * hidden in either search tab within the last 24 h are left out.
 *
 * One job per rule at a time: if a rule's job is still running, its
 * later due slots wait for the next tick (and are skipped if they
 * become more than 15 minutes late).
 */

const firingRules = new Set<string>();

function firedKey(ruleId: string, date: string): string {
  return `autoPost:${ruleId}:${date}`;
}

export async function getFiredSlotKeys(ruleId: string, date: string): Promise<string[]> {
  return getMeta<string[]>(firedKey(ruleId, date), []);
}

async function markFired(ruleId: string, date: string, slotKey: string): Promise<void> {
  const keys = await getFiredSlotKeys(ruleId, date);
  if (!keys.includes(slotKey)) {
    await setMeta(firedKey(ruleId, date), [...keys, slotKey]);
  }
}

/** Next scheduled fire for a rule (for the UI status line). */
export async function nextFireForRule(
  rule: AutoPostRule,
  now = Date.now(),
): Promise<AutoPostSlot | null> {
  const fired = await getFiredSlotKeys(rule.id, localDateString(now));
  return nextSlot(rule, now, fired);
}

/** True when the account was judged hidden in either search tab within 24 h. */
async function isSearchBannedRecently(accountId: string, now: number): Promise<boolean> {
  const latest = await latestBanCheckFor(accountId);
  if (!latest) return false;
  if (now - latest.checkedAt > 24 * 3600_000) return false;
  return latest.topicVisible === false || latest.latestVisible === false;
}

function payloadFromTemplate(rule: AutoPostRule, template: NonNullable<Awaited<ReturnType<typeof getTemplate>>>): ComposePayload {
  return {
    segments: [template.body, ...template.thread],
    targetType: 'normal',
    media: template.media,
    mediaMode: rule.mediaMode ?? 'all',
    mediaRandomCount: rule.mediaRandomCount,
    poll: template.poll,
    replyPermission: 'everyone',
    paidPartnership: false,
  };
}

/**
 * One engine tick: evaluate every enabled rule and fire due slots.
 * Returns the run rows recorded immediately (late skips and
 * search-ban skips); rows for fired jobs are recorded when each job
 * completes.
 */
export async function tickAutoPost(now = Date.now()): Promise<void> {
  const rules = (await listAutoPostRules()).filter((r) => r.enabled);
  if (rules.length === 0) return;
  const accounts = await listAccounts();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const today = new Date(now);
  const yesterday = new Date(now - 24 * 3600_000);
  const todayKey = localDateString(now);

  for (const rule of rules) {
    const shape: AutoPostRuleShape = rule;
    // 発火済みキーは今日＋昨日を見る。昨日のスロットは今日のキー
    // だけでは拾えず、処理済みの遅刻スロットを毎日スキップ記録
    // として重ねてしまうため（スロットキー自体に日付が入っている
    // ので、今日のキーへの保存はそのままでよい）。
    const firedToday = await getFiredSlotKeys(rule.id, todayKey);
    const firedYesterday = await getFiredSlotKeys(rule.id, localDateString(yesterday.getTime()));
    const fired = [...new Set([...firedToday, ...firedYesterday])];
    const firedSet = new Set(fired);
    // Today + yesterday (overnight random windows spill past midnight).
    // Slots are computed with a rng seeded per rule + day, so the
    // day's schedule is stable across ticks (re-computing with
    // Math.random would move the jittered times on every tick).
    const due: AutoPostSlot[] = [];
    const skippedLate: AutoPostSlot[] = [];
    for (const day of [yesterday, today]) {
      const rng = seededRandom(`${rule.id}:${localDateString(day.getTime())}`);
      const split = dueSlots(shape, day, now, fired, rng);
      due.push(...split.due);
      skippedLate.push(...split.skippedLate);
    }

    for (const slot of skippedLate) {
      if (firedSet.has(slot.key)) continue;
      await addAutoPostRun({
        ruleId: rule.id,
        ruleName: rule.name,
        accountId: rule.accountIds[0] ?? '',
        templateId: rule.templateId,
        status: 'skipped',
        reason: `予定時刻（${slot.label}）を15分以上過ぎたためスキップ`,
        at: now,
      });
      await markFired(rule.id, todayKey, slot.key);
      firedSet.add(slot.key);
    }

    if (due.length === 0) continue;
    if (firingRules.has(rule.id)) continue; // one job per rule at a time

    const template = await getTemplate(rule.templateId);
    if (!template || !template.body.trim()) {
      for (const slot of due) {
        await addAutoPostRun({
          ruleId: rule.id,
          ruleName: rule.name,
          accountId: rule.accountIds[0] ?? '',
          templateId: rule.templateId,
          status: 'skipped',
          reason: 'テンプレートが空のためスキップ',
          at: now,
        });
        await markFired(rule.id, todayKey, slot.key);
      }
      continue;
    }

    // Fire the first due slot; later ones wait for the next tick.
    const slot = due[0];
    const eligible: string[] = [];
    for (const accountId of rule.accountIds) {
      if (!byId.has(accountId)) continue;
      if (rule.skipIfSearchBan && (await isSearchBannedRecently(accountId, now))) {
        await addAutoPostRun({
          ruleId: rule.id,
          ruleName: rule.name,
          accountId,
          templateId: rule.templateId,
          status: 'skipped',
          reason: '24時間以内にサーチバン判定が出ているため見送り',
          at: now,
        });
        continue;
      }
      eligible.push(accountId);
    }
    await markFired(rule.id, todayKey, slot.key);
    if (eligible.length === 0) continue;

    firingRules.add(rule.id);
    const payload = payloadFromTemplate(rule, template);
    void createAndRunJob({
      accountIds: eligible,
      payload,
      // §6-6: 60 s + 0–30 s random spacing between accounts.
      intervalSec: 60,
      intervalJitterSec: 30,
      kind: 'immediate',
    })
      .then(async (job) => {
        for (const entry of job.entries) {
          await addAutoPostRun({
            ruleId: rule.id,
            ruleName: rule.name,
            accountId: entry.accountId,
            templateId: rule.templateId,
            status: entry.status === 'done' ? 'done' : entry.status === 'skipped' ? 'skipped' : 'failed',
            reason: entry.status === 'done' ? undefined : (entry.error ?? '投稿に失敗しました'),
            postUrl: entry.postUrl,
            at: entry.at ?? Date.now(),
          });
        }
      })
      .catch(() => {
        /* job errors are recorded per entry; nothing more to do */
      })
      .finally(() => {
        firingRules.delete(rule.id);
      });
  }
}
