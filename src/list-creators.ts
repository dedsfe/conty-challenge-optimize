import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type ReachRow = { creator_id: string; reach: number };
type DeliveryCountRow = { creator_id: string; n: number };

function compareCreators(
  left: { id: string; niche_score: number; latest_reach: number },
  right: { id: string; niche_score: number; latest_reach: number },
): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT id, niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const matched: Array<{ id: string; name: string; niche_score: number }> = [];
  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore > 0) matched.push({ id: creator.id, name: creator.name, niche_score: nicheScore });
  }

  // Soma, por criador, a métrica mais recente de cada conta (captured_at, depois id decrescente).
  const reachRows = await all<ReachRow>(
    db,
    `SELECT a.creator_id AS creator_id, SUM(m.views) AS reach
       FROM social_accounts a
       JOIN metrics m ON m.id = (
         SELECT id FROM metrics WHERE account_id = a.id ORDER BY captured_at DESC, id DESC LIMIT 1
       )
      GROUP BY a.creator_id`,
  );
  const reachByCreator = new Map(reachRows.map((row) => [row.creator_id, Number(row.reach)]));

  const scored = matched.map((creator) => ({
    ...creator,
    latest_reach: reachByCreator.get(creator.id) ?? 0,
  }));
  scored.sort(compareCreators);
  const pageRows = scored.slice(input.offset, input.offset + input.limit);

  const deliveriesByCreator = new Map<string, number>();
  if (pageRows.length > 0) {
    const placeholders = pageRows.map(() => "?").join(", ");
    const deliveryRows = await all<DeliveryCountRow>(
      db,
      `SELECT creator_id, COUNT(*) AS n FROM deliveries
        WHERE delivered_at >= ? AND creator_id IN (${placeholders})
        GROUP BY creator_id`,
      deliveriesSince(),
      ...pageRows.map((creator) => creator.id),
    );
    for (const row of deliveryRows) deliveriesByCreator.set(row.creator_id, Number(row.n));
  }

  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: pageRows.map((creator) => ({
      id: creator.id,
      name: creator.name,
      niche_score: creator.niche_score,
      latest_reach: creator.latest_reach,
      deliveries_90d: deliveriesByCreator.get(creator.id) ?? 0,
    })),
  };
}
