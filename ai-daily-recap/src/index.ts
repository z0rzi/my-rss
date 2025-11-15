import { serve } from "bun";
import RSS from "rss";
import Parser from "rss-parser";
import {
  filterArticlesByDate,
  formatDate,
  generateHistoricalRecaps,
  generateRecapForArticles,
} from "./recap";
import {
  getDailyRecaps,
  initializeStorage,
  readStorage,
  storeRecap,
} from "./storage";
import { DailyRecap } from "./types";

/**
 * Extracts domain from a URL for display purposes.
 * Returns the hostname without protocol or path.
 * Fallback to "Unknown" if URL parsing fails.
 *
 * @param url - The URL to extract domain from
 * @returns Domain string (e.g., "example.com")
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "Unknown";
  }
}

/**
 * Builds an RSS feed from stored daily recaps.
 *
 * Algorithm:
 * 1. Create RSS feed with metadata derived from source feed URL
 * 2. Sort recaps by date (newest first)
 * 3. Add each recap as an RSS item with proper formatting
 * 4. Return XML string
 *
 * @param feedUrl - The source RSS feed URL
 * @param recaps - Array of DailyRecap objects to include
 * @returns RSS XML string
 */
function buildRSSFeed(feedUrl: string, recaps: DailyRecap[]): string {
  const domain = extractDomain(feedUrl);
  const serverUrl = `http://localhost:${process.env.PORT || 3000}`;

  const feed = new RSS({
    title: `AI Daily Recap - ${domain}`,
    description: `Daily AI-generated summaries from ${feedUrl}`,
    feed_url: `${serverUrl}/?feed=${encodeURIComponent(feedUrl)}`,
    site_url: feedUrl,
    language: "en",
  });

  // Sort recaps by date (newest first)
  const sortedRecaps = [...recaps].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  for (const recap of sortedRecaps) {
    feed.item({
      title: `Daily Recap - ${recap.date}`,
      description: recap.html,
      url: feedUrl,
      guid: `${feedUrl}#${recap.date}`,
      date: new Date(recap.date),
    });
  }

  return feed.xml();
}

/**
 * Generates a daily recap for a specific feed for yesterday's date.
 * Fetches the feed, filters articles for yesterday, and generates recap if articles found.
 *
 * @param feedUrl - The RSS feed URL to process
 * @returns Promise that resolves when recap is generated and stored
 */
async function generateRecapForFeed(feedUrl: string): Promise<void> {
  const parser = new Parser();
  const feed = await parser.parseURL(feedUrl);

  // Get yesterday's date
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  // Filter articles for yesterday
  const articlesForYesterday = filterArticlesByDate(feed.items, yesterday);

  if (articlesForYesterday.length > 0) {
    const html = await generateRecapForArticles(articlesForYesterday);

    const recap: DailyRecap = {
      date: formatDate(yesterday),
      html: html,
      articles: articlesForYesterday,
    };

    storeRecap(feedUrl, recap);
    console.log(
      `Generated recap for ${feedUrl} on ${formatDate(yesterday)}: ${articlesForYesterday.length} articles`,
    );
  } else {
    console.log(`No articles found for ${feedUrl} on ${formatDate(yesterday)}`);
  }
}

/**
 * Generates daily recaps for all tracked feeds.
 * Called by scheduler at midnight.
 * Processes all feeds in parallel with individual error handling.
 */
async function generateDailyRecapsForAllFeeds(): Promise<void> {
  console.log("Starting daily recap generation for all feeds...");
  const storage = readStorage();

  const feedKeys = Object.keys(storage);
  const promises = feedKeys.map(async (feedUrl) => {
    return generateRecapForFeed(feedUrl).catch((err) => {
      console.error(`Failed to generate recap for ${feedUrl}:`, err);
    });
  });

  await Promise.all(promises);
  console.log("Daily recap generation completed for all feeds");
}

// Initialize storage at startup
initializeStorage();
console.log("Storage initialized");

// Check for required environment variables
if (!process.env.OPENROUTER_API_KEY) {
  console.warn(
    "WARNING: OPENROUTER_API_KEY not set - AI recap generation will fail",
  );
}

// Start HTTP server
const port = Number(process.env.PORT) || 3000;
serve({
  port: port,
  idleTimeout: 60000,
  routes: {
    /**
     * Main RSS endpoint.
     * Accepts `feed` query parameter and returns transformed RSS with AI recaps.
     * Automatically initializes and generates historical recaps for new feeds.
     */
    "/": async (req) => {
      try {
        const url = new URL(req.url);
        const feedUrl = url.searchParams.get("feed");

        if (!feedUrl) {
          return new Response("No feed specified", { status: 400 });
        }

        // Try to get existing feed recaps
        let recaps = getDailyRecaps(feedUrl);

        if (!recaps) {
          // If feed is new, initialize and generate historical recaps
          console.log(`New feed detected: ${feedUrl}`);
          console.log("Generating historical recaps (5 days)...");

          try {
            await generateHistoricalRecaps(feedUrl, 5);
            console.log(`Historical recaps generated for ${feedUrl}`);
          } catch (error) {
            console.error(
              `Failed to generate historical recaps for ${feedUrl}:`,
              error,
            );
            // Continue even if historical generation fails
          }

          // Refresh feed recaps after generation
          recaps = getDailyRecaps(feedUrl);
        }

        recaps = recaps || [];

        // Only giving 7 days of recaps
        const today = Date.now();
        const msInDay = 24 * 60 * 60 * 1000;
        const recentRecaps = recaps.filter(
          (r) => (today - Date.parse(r.date)) < msInDay * 7,
        );

        // Build RSS feed from stored recaps
        const rssXml = buildRSSFeed(feedUrl, recentRecaps);

        return new Response(rssXml, {
          headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      } catch (error) {
        console.error("Error processing request:", error);
        return new Response(`Error: ${error}`, { status: 500 });
      }
    },
  },
});

console.log(`AI Daily Recap server started on port ${port}`);
console.log("");
console.log("To add a new feed: http://ai-daily-recap?feed=<ENCODED_FEED_URL>");
console.log("");
console.log("Or with Node:");
console.log("'http://ai-daily-recap?feed=' + encodeURIComponent('https://...')");

const now = Date.now();
const msInDay = 24 * 60 * 60 * 1000;
const msFromMidnight = now % msInDay;
const msToMidnight = msInDay - msFromMidnight;

setTimeout(() => {
  // Will trigger at midnight
  setInterval(() => {
    // Will trigger every day at midnight
    generateDailyRecapsForAllFeeds().catch((err) => {
      console.error("Failed to generate daily recaps:", err);
    });
  }, msInDay);
}, msToMidnight);
