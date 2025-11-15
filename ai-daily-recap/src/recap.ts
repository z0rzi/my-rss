import Parser from "rss-parser";
import { askAi, AiModels } from "./ai";
import { ArticleReference, DailyRecap } from "./types";
import { storeRecap } from "./storage";

/**
 * Formats a Date object into YYYY-MM-DD string format.
 * Used for consistent date representation across the application.
 *
 * @param date - The date to format
 * @returns String in YYYY-MM-DD format (e.g., "2025-11-14")
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Filters RSS feed items by a specific date and converts them to ArticleReference objects.
 *
 * Algorithm:
 * 1. Convert target date to YYYY-MM-DD string
 * 2. Filter items where pubDate matches the target date (same calendar day)
 * 3. Map filtered items to ArticleReference objects
 * 4. Handle missing fields with sensible defaults
 *
 * @param items - Array of RSS items from rss-parser
 * @param targetDate - The date to filter by (only items from this calendar day)
 * @returns Array of ArticleReference objects for the specified date
 */
export function filterArticlesByDate(
  items: Parser.Item[],
  targetDate: Date,
): ArticleReference[] {
  const targetDateStr = formatDate(targetDate);
  const filtered = items
    .filter((item) => {
      if (!item.pubDate) return false;
      const itemDate = new Date(item.pubDate);
      const itemDateStr = formatDate(itemDate);
      return itemDateStr === targetDateStr;
    })
    .map((item) => ({
      title: item.title || "Untitled",
      link: item.link || "",
      description: item.contentSnippet || item.content || "",
      pubDate: item.pubDate || new Date().toISOString(),
    }));

  return filtered;
}

/**
 * Generates an AI-powered recap for a collection of articles from a specific date.
 *
 * Algorithm:
 * 1. Limit articles to first 50 to avoid huge LLM contexts
 * 2. Build system message with instructions for the AI curator
 * 3. Format articles as numbered list with titles, links, and descriptions
 * 4. Send messages to LLM via askAi()
 * 5. Return the generated html recap
 *
 * @param articles - Array of ArticleReference objects to summarize
 * @param targetDate - The date being recapped
 * @returns Promise resolving to html-formatted recap text
 */
export async function generateRecapForArticles(
  articles: ArticleReference[],
): Promise<string> {
  // Limit to first 50 articles to avoid huge contexts
  const limitedArticles = articles.slice(0, 50);

  // Build system message with instructions
  const systemMessage = {
    role: "system" as const,
    content: `You are an intelligent news curator. Your job is to analyze a day's worth of articles and create a concise, engaging summary highlighting the most important and interesting stories. 

Rules:
1. Focus on 3-5 major stories maximum
2. Include clickable links to original articles
3. Use html formatting
4. Be concise but informative
5. Prioritize stories that are newsworthy, impactful, or particularly interesting
6. Never include stories about sports
7. Ignore minor or repetitive stories
8. Write in a professional but engaging tone
9. Always respect the source's language (recap in french if the source is in french, english if the source is in english.)`,
  };

  // Format articles text
  const articlesText = limitedArticles
    .map((article, index) => {
      return `${index + 1}. [${article.title}](${article.link})\n   Description: ${article.description}`;
    })
    .join("\n\n");

  // Build user message
  const userMessage = {
    role: "user" as const,
    content: `Here are today's articles:\n\n${articlesText}\n\nGenerate a daily recap.`,
  };

  // Call AI to generate recap
  const html = await askAi([systemMessage, userMessage], {
    model: AiModels.GPT4_1,
  });

  return html;
}

/**
 * Generates historical recaps for the past N days for a given feed URL.
 *
 * Algorithm:
 * 1. Fetch RSS feed using RSSParser
 * 2. For each of the past N days (going backwards from today):
 *    - Calculate target date
 *    - Filter articles for that specific day
 *    - If articles found, generate recap and store it
 * 3. Process sequentially to avoid rate limiting
 *
 * Note: Processes days sequentially (not in parallel) to avoid overwhelming the LLM API.
 *
 * @param feedUrl - URL of the RSS feed to process
 * @param days - Number of past days to generate recaps for (default: 5)
 * @returns Promise that resolves when all historical recaps are generated
 */
export async function generateHistoricalRecaps(
  feedUrl: string,
  days: number = 5,
): Promise<void> {
  const parser = new Parser();
  const feed = await parser.parseURL(feedUrl);

  const today = new Date();

  // Process sequentially to avoid rate limiting
  for (let i = 1; i < days + 1; i++) {
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() - i);
    const articlesForDay = filterArticlesByDate(feed.items, targetDate);

    if (articlesForDay.length > 0) {
      try {
        const html = await generateRecapForArticles(articlesForDay);

        const recap: DailyRecap = {
          date: formatDate(targetDate),
          html: html,
          articles: articlesForDay,
        };

        storeRecap(feedUrl, recap);
      } catch (error) {
        // Continue with next day even if this one failed
      }
    }
  }
}
