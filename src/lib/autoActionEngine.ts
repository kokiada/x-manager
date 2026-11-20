import { executor } from '../executor';
import type { Account, AutoActionEvent } from '../db/types';
import {
  addAutoActionEvent,
  countAutoActionEventsToday,
  getRandomWordSets,
  getTemplate,
  listAccounts,
  listAutoActionEvents,
  listAutoActionRules,
  listPostAnalytics,
} from '../db/repository';
import { expandRandomText } from './randomText';
import {
  crossAccountStaggerMs,
  dailyCapReached,
  eligibleActingAccounts,
  isDuplicateAction,
  matchesKeywords,
  matchesKindFilter,
  median,
  sameAccountStaggerMs,
  tractionTriggered,
} from './autoAction';

/**
 * Auto-action engine (research §7-2).
 *
 * Reacts to a new post from a registered account: enabled rules whose
 * trigger account / kind filter / keywords match pick eligible acting
 * accounts (author and same-proxy accounts excluded) and run the
 * configured actions with the spec stagger (same account 10–30 s,
 * cross-account 2–6 s), enforcing the shared daily cap and the
 * no-double-reaction rule. Events are persisted as the activity feed.
 *
 * XBoard watches real posts while it runs; x-manager has no live X
 * feed, so the scheduler fabricates plausible incoming posts with
 * simulateIncomingPost() (clearly a demo trigger — the rule
 * evaluation itself is the real logic).
 */

export interface IncomingPost {
  postUrl: string;
  authorAccountId: string;
  authorHandle: string;
  text: string;
  hasImage: boolean;
  hasVideo: boolean;
  likes: number;
  reposts: number;
  views: number;
  postedAt: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DEMO_POST_TEXTS = [
  '試合お疲れさまでした！今日のベストプレーを振り返ります。',
  'スタジアムの雰囲気が最高でした。次節も現地で応援します。',
  '新加入選手のプレーに注目。ここ数試合の調子が良いです。',
  'チケット情報のお知らせです。お早めにご確認ください。',
  '今日の練習風景を少しだけ。明日に向けて調整中です。',
  'サポーターの皆さん、たくさんの応援ありがとうございました。',
];

/**
 * Fabricate a plausible incoming post from a random trigger account
 * (demo trigger for the engine; see the module comment).
 */
export function simulateIncomingPost(
  accounts: readonly Account[],
  rng: () => number = Math.random,
): IncomingPost | null {
  const candidates = accounts.filter((a) => a.status === 'logged_in');
  if (candidates.length === 0) return null;
  const author = candidates[Math.floor(rng() * candidates.length)];
  const now = Date.now();
  const postId = `${now}${Math.floor(rng() * 1000)}`;
  const roll = rng();
  return {
    postUrl: `https://x.com/${author.handle}/status/${postId}`,
    authorAccountId: author.id,
    authorHandle: author.handle,
    text: DEMO_POST_TEXTS[Math.floor(rng() * DEMO_POST_TEXTS.length)],
    hasImage: roll < 0.45,
    hasVideo: roll >= 0.45 && roll < 0.6,
    likes: Math.max(1, Math.round(author.followers * (0.005 + rng() * 0.03))),
    reposts: Math.max(0, Math.round(author.followers * rng() * 0.008)),
    views: Math.max(50, Math.round(author.followers * (0.1 + rng() * 0.4))),
    postedAt: now,
  };
}

export interface AutoActionRunOptions {
  sleepFn?: (ms: number) => Promise<void>;
  rng?: () => number;
}

/**
 * Evaluate all enabled rules against one incoming post and run the
 * matching actions. Returns the events recorded (done / skipped /
 * failed). Rules that do not match the post record nothing.
 */
export async function evaluateAndRunPost(
  post: IncomingPost,
  opts: AutoActionRunOptions = {},
): Promise<AutoActionEvent[]> {
  const sleepFn = opts.sleepFn ?? sleep;
  const rng = opts.rng ?? Math.random;
  const events: AutoActionEvent[] = [];
  const rules = (await listAutoActionRules()).filter((r) => r.enabled);
  if (rules.length === 0) return events;

  const accounts = await listAccounts();
  const author = accounts.find((a) => a.id === post.authorAccountId);
  if (!author) return events;

  const allEvents = await listAutoActionEvents(200);
  let doneToday = await countAutoActionEventsToday();
  // The daily cap is shared across all rules (§7-2); the effective
  // cap is the smallest cap among the enabled rules.
  const cap = Math.min(...rules.map((r) => r.dailyCap));

  const record = async (
    input: Omit<AutoActionEvent, 'id'>,
  ): Promise<AutoActionEvent> => {
    const event = await addAutoActionEvent(input);
    events.push(event);
    return event;
  };

  const lastActionByAccount = new Map<string, number>();
  let lastActionAt = 0;
  const staggerWait = async (accountId: string) => {
    const now = Date.now();
    const lastSame = lastActionByAccount.get(accountId);
    let wait = 0;
    if (lastSame !== undefined) {
      wait = Math.max(wait, lastSame + sameAccountStaggerMs(rng) - now);
    } else if (lastActionAt > 0) {
      wait = Math.max(wait, lastActionAt + crossAccountStaggerMs(rng) - now);
    }
    if (wait > 0) await sleepFn(wait);
    const at = Date.now();
    lastActionByAccount.set(accountId, at);
    lastActionAt = at;
  };

  for (const rule of rules) {
    if (!rule.triggerAccountIds.includes(post.authorAccountId)) continue;
    if (!matchesKindFilter(rule.kindFilter, post.hasImage, post.hasVideo)) continue;
    if (!matchesKeywords(post.text, rule.keywords ?? [])) continue;

    if (rule.trigger === 'on_traction') {
      const rows = await listPostAnalytics(post.authorAccountId, 200);
      if (rows.length < 5) continue; // §7-2: 5件以上たまってから判定
      const baseline = median(rows.map((r) => r.likes + r.reposts));
      if (baseline === null || !tractionTriggered(post.likes + post.reposts, baseline)) continue;
    }

    if (isDuplicateAction(allEvents, rule.id, post.postUrl)) {
      await record({
        ruleId: rule.id,
        ruleName: rule.name,
        postUrl: post.postUrl,
        authorHandle: post.authorHandle,
        actingAccountId: '',
        kind: 'like',
        status: 'skipped',
        reason: '同じルールで反応済みのためスキップ',
        at: Date.now(),
      });
      continue;
    }

    const acting = eligibleActingAccounts(accounts, author, rule.actingAccountIds);
    if (acting.length === 0) {
      await record({
        ruleId: rule.id,
        ruleName: rule.name,
        postUrl: post.postUrl,
        authorHandle: post.authorHandle,
        actingAccountId: '',
        kind: 'like',
        status: 'skipped',
        reason: '実行できるアカウントがありません（投稿者・同一プロキシ・ロック等を除外）',
        at: Date.now(),
      });
      continue;
    }

    const wordSets = await getRandomWordSets();
    const replyTemplates = [];
    for (const templateId of rule.replyTemplateIds ?? []) {
      const template = await getTemplate(templateId);
      if (template) replyTemplates.push(template);
    }
    // Templates already used for this post (non-random bodies must be
    // distinct per account, §7-2; a [RandomN] body expands differently
    // per account, so it may be reused).
    const usedTemplateIds = new Set<string>();

    for (const kind of rule.actionKinds) {
      for (const account of acting) {
        if (dailyCapReached(doneToday, cap)) {
          await record({
            ruleId: rule.id,
            ruleName: rule.name,
            postUrl: post.postUrl,
            authorHandle: post.authorHandle,
            actingAccountId: account.id,
            kind,
            status: 'skipped',
            reason: `1日の上限（${cap}件）に達しました`,
            at: Date.now(),
          });
          continue;
        }

        if (kind === 'reply') {
          // One distinct reply body per acting account (§7-2): use
          // the next unused template; a [RandomN] body counts as
          // distinct after per-account expansion, so it may be reused.
          const template = replyTemplates.find(
            (t) => !usedTemplateIds.has(t.id) || /\[Random\d+\]/.test(t.body),
          );
          if (!template) {
            await record({
              ruleId: rule.id,
              ruleName: rule.name,
              postUrl: post.postUrl,
              authorHandle: post.authorHandle,
              actingAccountId: account.id,
              kind,
              status: 'skipped',
              reason: 'リプライ用テンプレートが不足しています',
              at: Date.now(),
            });
            continue;
          }
          usedTemplateIds.add(template.id);
          await staggerWait(account.id);
          try {
            const text = expandRandomText(template.body, wordSets, rng);
            const result = await executor.executePost(account, {
              text,
              targetType: 'reply',
              replyToUrl: post.postUrl,
              mediaCount: 0,
            });
            await record({
              ruleId: rule.id,
              ruleName: rule.name,
              postUrl: post.postUrl,
              authorHandle: post.authorHandle,
              actingAccountId: account.id,
              kind,
              status: result.ok ? 'done' : 'failed',
              reason: result.ok ? undefined : (result.error ?? 'リプライに失敗しました'),
              at: result.at,
            });
            if (result.ok) doneToday++;
          } catch (err) {
            await record({
              ruleId: rule.id,
              ruleName: rule.name,
              postUrl: post.postUrl,
              authorHandle: post.authorHandle,
              actingAccountId: account.id,
              kind,
              status: 'failed',
              reason: err instanceof Error ? err.message : 'リプライに失敗しました',
              at: Date.now(),
            });
          }
          continue;
        }

        await staggerWait(account.id);
        try {
          const result = await executor.executeAction(account, kind, { postUrl: post.postUrl });
          await record({
            ruleId: rule.id,
            ruleName: rule.name,
            postUrl: post.postUrl,
            authorHandle: post.authorHandle,
            actingAccountId: account.id,
            kind,
            status: result.ok ? 'done' : 'failed',
            reason: result.ok ? undefined : (result.error ?? '実行に失敗しました'),
            at: result.at,
          });
          if (result.ok) doneToday++;
        } catch (err) {
          await record({
            ruleId: rule.id,
            ruleName: rule.name,
            postUrl: post.postUrl,
            authorHandle: post.authorHandle,
            actingAccountId: account.id,
            kind,
            status: 'failed',
            reason: err instanceof Error ? err.message : '実行に失敗しました',
            at: Date.now(),
          });
        }
      }
    }
  }
  return events;
}

/**
 * One scheduler cycle: with the given probability, fabricate an
 * incoming post from a trigger account and run the engine. Returns
 * the events recorded (empty when nothing fired).
 */
export async function runAutoActionCycle(opts: {
  probability?: number;
  rng?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
} = {}): Promise<AutoActionEvent[]> {
  const rng = opts.rng ?? Math.random;
  const rules = (await listAutoActionRules()).filter((r) => r.enabled);
  if (rules.length === 0) return [];
  if (rng() >= (opts.probability ?? 0.5)) return [];
  const triggerIds = new Set(rules.flatMap((r) => r.triggerAccountIds));
  const accounts = (await listAccounts()).filter((a) => triggerIds.has(a.id));
  const post = simulateIncomingPost(accounts, rng);
  if (!post) return [];
  return evaluateAndRunPost(post, { sleepFn: opts.sleepFn, rng });
}
