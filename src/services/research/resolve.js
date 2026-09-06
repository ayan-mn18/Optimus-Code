/**
 * Finds the LeetCode twin for a design question.
 *
 * The catalogue carries no leetcode_url for any of its 278 entries, so this
 * stage earns them. The GraphQL endpoint answers unauthenticated, which the
 * scraped HTML page does not — it 403s every bot.
 */

const GRAPHQL = 'https://leetcode.com/graphql';

const QUERY = `query q($t: String!) {
  question(titleSlug: $t) { questionFrontendId title titleSlug difficulty topicTags { name } }
}`;

/** "Design an ATM Machine" -> candidate slugs, most likely first. */
export function candidateSlugs(title) {
  const base = title
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const withoutLead = base.replace(/^design-(a-|an-|the-)?/, '');
  return [...new Set([
    base,
    `design-${withoutLead}`,
    `design-a-${withoutLead}`,
    `design-an-${withoutLead}`,
    withoutLead,
    base.replace(/-system$/, ''),
    base.replace(/-game$/, ''),
    base.replace(/-machine$/, ''),
  ])].filter(Boolean);
}

export async function resolveLeetCode(title, { fetchImpl = fetch } = {}) {
  for (const slug of candidateSlugs(title)) {
    try {
      const response = await fetchImpl(GRAPHQL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({ query: QUERY, variables: { t: slug } }),
      });
      if (!response.ok) continue;

      const question = (await response.json())?.data?.question;
      if (question) {
        return {
          id: question.questionFrontendId,
          slug: question.titleSlug,
          title: question.title,
          difficulty: question.difficulty,
          topics: (question.topicTags ?? []).map((tag) => tag.name),
          url: `https://leetcode.com/problems/${question.titleSlug}/`,
        };
      }
    } catch {
      // A miss is normal — "Design Splitwise" has no LeetCode twin.
    }
  }
  return null;
}
